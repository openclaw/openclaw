import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const destination = path.join(root, "apps/linux/src-tauri/target/desktop-runtime");

export function resourceBytes(executable) {
  // linuxdeploy rewrites ELF resources even without executable permissions.
  // This fixed envelope is stripped by bundled_runtime.rs; hashes cover raw bytes.
  return Buffer.concat([Buffer.from("OPENCLAW-BUN-RUNTIME-V1\n"), executable]);
}

export function runtimeTarget(triple) {
  if (
    triple.endsWith("-apple-darwin") ||
    triple.endsWith("-unknown-freebsd")
  ) {
    return null; // These platforms keep their existing runtime owner.
  }
  const platform = triple.endsWith("-unknown-linux-gnu") ? "linux"
    : triple.endsWith("-pc-windows-msvc") ? "windows" : null;
  const arch = triple.startsWith("aarch64-") ? "arm64" : triple.startsWith("x86_64-") ? "x64" : null;
  if (!platform || !arch) {
    throw new Error(`Unsupported embedded runtime target: ${triple}`);
  }
  return { platform, arch };
}

function run(script, args) {
  // Git Bash supplies the shared stager's zip and POSIX file tools on Windows.
  if (process.platform === "win32") {
    execFileSync("bash", [script, ...args].map(value => value.replaceAll("\\", "/")), {
      cwd: root, stdio: "inherit",
    });
  } else {
    execFileSync(script, args, { cwd: root, stdio: "inherit" });
  }
}

export function runtimeIdentity(pin, target, unsignedWindowsArtifact) {
  if (unsignedWindowsArtifact && target?.platform !== "windows") {
    throw new Error("Unsigned artifact proof requires a Windows target");
  }
  if (!target) {
    return null;
  }
  const artifact = pin.artifacts[`${target.platform}-${target.arch}`];
  if (target.platform !== "windows") {
    return { tag: pin.tag, commit: pin.commit, revision: pin.revision };
  }
  if (unsignedWindowsArtifact && !artifact) {
    throw new Error("Unsigned artifact proof requires a pinned Windows target");
  }
  if (!artifact || (!unsignedWindowsArtifact && artifact.authenticodeSigned !== true)) {
    return null;
  }
  if (unsignedWindowsArtifact && artifact.authenticodeSigned !== false) {
    throw new Error("Unsigned artifact proof requires an explicitly unsigned Windows pin");
  }
  return {
    tag: artifact.tag, commit: artifact.commit,
    ...(artifact.revision ? { revision: artifact.revision } : {}),
    authenticodeSigned: artifact.authenticodeSigned === true,
    ...(unsignedWindowsArtifact ? { testOnly: true } : {}),
  };
}

export function stageRuntime(triple, unsignedWindowsArtifact) {
  const target = runtimeTarget(triple);
  const pin = JSON.parse(fs.readFileSync(path.join(root, "scripts/lib/openclaw-bun.json"), "utf8"));
  const identity = runtimeIdentity(pin, target, unsignedWindowsArtifact);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const work = fs.mkdtempSync(`${destination}-`);
  try {
    if (identity) {
      run(path.join(root, "scripts/stage-openclaw-bun.sh"), [work, target.platform, target.arch,
        ...(unsignedWindowsArtifact ? ["--unsigned-windows-artifact", path.resolve(unsignedWindowsArtifact)] : []),
      ]);
      const executableName = target.platform === "windows" ? "bin/bun.exe" : "bin/bun";
      const executablePath = path.join(work, executableName);
      const executable = fs.readFileSync(executablePath);
      fs.writeFileSync(executablePath, resourceBytes(executable));
      fs.chmodSync(executablePath, 0o644);
      const files = { [executableName]: createHash("sha256").update(executable).digest("hex") };
      fs.writeFileSync(path.join(work, "manifest.json"), `${JSON.stringify({
        ...identity, ...target, files,
      }, null, 2)}\n`);
      fs.rmSync(path.join(work, "bun-manifest.json"));
    } else {
      fs.writeFileSync(path.join(work, "manifest.json"), "{}\n");
    }
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(work, destination);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = `${process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch}-${process.platform === "darwin" ? "apple-darwin" : process.platform === "linux" ? "unknown-linux-gnu" : process.platform === "win32" ? "pc-windows-msvc" : `unknown-${process.platform}`}`;
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--unsigned-windows-artifact" || !args[1])) {
    throw new Error("Usage: stage-runtime.mjs [--unsigned-windows-artifact <local-release-directory>]");
  }
  stageRuntime(process.env.TAURI_ENV_TARGET_TRIPLE || host, args[1]);
}
