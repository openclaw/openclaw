import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as tar from "tar";

const BUNDLED_RUNTIME_ENTRIES = ["package.json", "dist", "node_modules", "docs"];
const FORBIDDEN_RUNTIME_STATE_ENTRIES = [
  ".openclaw",
  "openclaw.json",
  "models.json",
  "secrets.json",
  "channel-bindings.json",
  "bindings.json",
];
const CONTROL_UI_INDEX_PATH_SEGMENTS = ["dist", "control-ui", "index.html"];
const CONTROL_UI_DESKTOP_ASSETS = [
  {
    source: ["apps", "desktop-tauri", "loading.html"],
    target: ["dist", "control-ui", "loading.html"],
  },
  {
    source: ["apps", "desktop-tauri", "loading.js"],
    target: ["dist", "control-ui", "loading.js"],
  },
  {
    source: ["apps", "desktop-tauri", "src-tauri", "icons", "icon.png"],
    target: ["dist", "control-ui", "icon.png"],
  },
];

function runOrThrow(command, args, cwd, useShell = false) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: useShell,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Command failed (${command} ${args.join(" ")}), exit code ${result.status ?? "null"}`,
    );
  }
}

function resolveTauriSidecarBinaryName() {
  if (process.platform === "win32" && process.arch === "x64") {
    return "node-x86_64-pc-windows-msvc.exe";
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "node-aarch64-apple-darwin";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "node-x86_64-apple-darwin";
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "node-x86_64-unknown-linux-gnu";
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return "node-aarch64-unknown-linux-gnu";
  }
  throw new Error(`Unsupported desktop bundle host: ${process.platform}/${process.arch}`);
}

function ensureNodeBinary(desktopTauriSrcTauriDir) {
  const binariesDir = join(desktopTauriSrcTauriDir, "binaries");
  const targetBinary = join(desktopTauriSrcTauriDir, "binaries", resolveTauriSidecarBinaryName());
  const sourceNodeBinary = process.execPath;
  if (!existsSync(sourceNodeBinary)) {
    throw new Error(`Unable to find Node executable at: ${sourceNodeBinary}`);
  }

  mkdirSync(dirname(targetBinary), { recursive: true });
  for (const entry of readdirSync(binariesDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.startsWith("gateway-") || entry.name.startsWith("node-")) {
      safeRm(join(binariesDir, entry.name));
    }
  }
  cpSync(sourceNodeBinary, targetBinary);
  if (process.platform !== "win32") {
    chmodSync(targetBinary, 0o755);
  }
}

function ensureControlUiBuilt(repoRoot) {
  const controlUiIndexPath = join(repoRoot, ...CONTROL_UI_INDEX_PATH_SEGMENTS);
  if (existsSync(controlUiIndexPath)) {
    return;
  }

  const uiBuildScript = join(repoRoot, "scripts", "ui.js");
  if (!existsSync(uiBuildScript)) {
    throw new Error(`Missing UI build script: ${uiBuildScript}`);
  }

  console.log("[prepare-runtime] Control UI assets missing; running ui build");
  runOrThrow(process.execPath, [uiBuildScript, "build"], repoRoot);

  if (!existsSync(controlUiIndexPath)) {
    throw new Error(
      `Control UI assets are still missing after ui build: ${controlUiIndexPath}`,
    );
  }
}

function ensureDesktopControlUiAssets(repoRoot) {
  for (const asset of CONTROL_UI_DESKTOP_ASSETS) {
    cpSync(join(repoRoot, ...asset.source), join(repoRoot, ...asset.target));
  }
}

function assertNoBundledUserState(runtimeOpenclawDir) {
  for (const name of FORBIDDEN_RUNTIME_STATE_ENTRIES) {
    const path = join(runtimeOpenclawDir, name);
    if (existsSync(path)) {
      throw new Error(`Refusing to bundle local runtime state into installer: ${path}`);
    }
  }
}

function safeRm(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[prepare-runtime] skip delete: ${path} (${message})`);
  }
}

function rmRuntimeEntryOrThrow(path) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
      return;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
    }
  }
}

function pruneBrokenLinks(rootDir) {
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      let stats;
      try {
        stats = lstatSync(entryPath);
      } catch (error) {
        const code = error && typeof error === "object" ? error.code : undefined;
        if (code === "ENOENT") {
          safeRm(entryPath);
          continue;
        }
        throw error;
      }

      if (stats.isSymbolicLink()) {
        try {
          realpathSync(entryPath);
        } catch (error) {
          const code = error && typeof error === "object" ? error.code : undefined;
          if (code === "ENOENT") {
            safeRm(entryPath);
            continue;
          }
          throw error;
        }
      }

      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        walk(entryPath);
      }
    }
  };

  if (existsSync(rootDir)) {
    walk(rootDir);
  }
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const desktopTauriDir = resolve(scriptDir, "..");
  const desktopTauriSrcTauriDir = resolve(desktopTauriDir, "src-tauri");
  const repoRoot = resolve(desktopTauriDir, "..", "..");

  const distDir = join(repoRoot, "dist");
  if (!existsSync(distDir)) {
    throw new Error(`Missing dist directory: ${distDir}. Run 'pnpm build' first.`);
  }

  ensureControlUiBuilt(repoRoot);
  ensureDesktopControlUiAssets(repoRoot);
  ensureNodeBinary(desktopTauriSrcTauriDir);

  const runtimeRoot = join(desktopTauriSrcTauriDir, "runtime");
  const runtimeOpenclawDir = join(runtimeRoot, "openclaw");
  const runtimeArchivePath = join(runtimeRoot, "openclaw-runtime.tar.gz");
  const runtimeTemplatesDir = join(runtimeOpenclawDir, "docs", "reference", "templates");

  mkdirSync(runtimeOpenclawDir, { recursive: true });
  rmRuntimeEntryOrThrow(join(runtimeOpenclawDir, "dist"));
  rmRuntimeEntryOrThrow(runtimeTemplatesDir);
  rmRuntimeEntryOrThrow(join(runtimeOpenclawDir, "node_modules"));
  rmRuntimeEntryOrThrow(join(runtimeOpenclawDir, "package-lock.json"));
  rmRuntimeEntryOrThrow(runtimeArchivePath);

  cpSync(join(repoRoot, "package.json"), join(runtimeOpenclawDir, "package.json"));
  cpSync(distDir, join(runtimeOpenclawDir, "dist"), { recursive: true });
  cpSync(
    join(repoRoot, "docs", "reference", "templates"),
    runtimeTemplatesDir,
    { recursive: true },
  );

  if (process.platform === "win32") {
    runOrThrow(
      "npm install --omit=dev --ignore-scripts --no-audit --no-fund --legacy-peer-deps",
      [],
      runtimeOpenclawDir,
      true,
    );
  } else {
    runOrThrow(
      "npm",
      ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps"],
      runtimeOpenclawDir,
    );
  }

  assertNoBundledUserState(runtimeOpenclawDir);
  pruneBrokenLinks(join(runtimeOpenclawDir, "node_modules"));

  tar.c(
    {
      cwd: runtimeOpenclawDir,
      file: runtimeArchivePath,
      gzip: true,
      portable: true,
    },
    BUNDLED_RUNTIME_ENTRIES,
  );
}

await main();
