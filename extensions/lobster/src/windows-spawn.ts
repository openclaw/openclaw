import fs from "node:fs";
import path from "node:path";

type SpawnTarget = {
  command: string;
  argv: string[];
  windowsHide?: boolean;
};

function isFilePath(value: string): boolean {
  try {
    const stat = fs.statSync(value);
    return stat.isFile();
  } catch {
    return false;
  }
}

function resolveWindowsExecutablePath(execPath: string, env: NodeJS.ProcessEnv): string {
  if (execPath.includes("/") || execPath.includes("\\") || path.isAbsolute(execPath)) {
    return execPath;
  }

  const pathValue = env.PATH ?? env.Path ?? process.env.PATH ?? process.env.Path ?? "";
  const pathEntries = pathValue
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const hasExtension = path.extname(execPath).length > 0;
  const pathExtRaw =
    env.PATHEXT ??
    env.Pathext ??
    process.env.PATHEXT ??
    process.env.Pathext ??
    ".EXE;.CMD;.BAT;.COM";
  const pathExt = hasExtension
    ? [""]
    : pathExtRaw
        .split(";")
        .map((ext) => ext.trim())
        .filter(Boolean)
        .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));

  for (const dir of pathEntries) {
    for (const ext of pathExt) {
      for (const candidateExt of [ext, ext.toLowerCase(), ext.toUpperCase()]) {
        const candidate = path.join(dir, `${execPath}${candidateExt}`);
        if (isFilePath(candidate)) {
          return candidate;
        }
      }
    }
  }

  return execPath;
}

function resolveBinEntry(binField: string | Record<string, string> | undefined): string | null {
  if (typeof binField === "string") {
    const trimmed = binField.trim();
    return trimmed || null;
  }
  if (!binField || typeof binField !== "object") {
    return null;
  }

  const preferred = binField.lobster;
  if (typeof preferred === "string" && preferred.trim()) {
    return preferred.trim();
  }

  for (const value of Object.values(binField)) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function resolveLobsterScriptFromPackageJson(wrapperPath: string): string | null {
  const wrapperDir = path.dirname(wrapperPath);
  const packageDirs = [
    // Local install: <repo>/node_modules/.bin/lobster.cmd -> ../lobster
    path.resolve(wrapperDir, "..", "lobster"),
    // Global npm install: <npm-prefix>/lobster.cmd -> ./node_modules/lobster
    path.resolve(wrapperDir, "node_modules", "lobster"),
  ];

  for (const packageDir of packageDirs) {
    const packageJsonPath = path.join(packageDir, "package.json");
    if (!isFilePath(packageJsonPath)) {
      continue;
    }

    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
        bin?: string | Record<string, string>;
      };
      const scriptRel = resolveBinEntry(packageJson.bin);
      if (!scriptRel) {
        continue;
      }
      const scriptPath = path.resolve(packageDir, scriptRel);
      if (isFilePath(scriptPath)) {
        return scriptPath;
      }
    } catch {
      // Ignore malformed package metadata; caller will throw a guided error.
    }
  }

  return null;
}

function resolveLobsterScriptFromCmdShim(wrapperPath: string): string | null {
  if (!isFilePath(wrapperPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(wrapperPath, "utf8");
    const candidates: string[] = [];
    const extractRelativeFromToken = (token: string): string | null => {
      const match = token.match(/%~?dp0%\s*[\\/]*(.*)$/i);
      if (!match) {
        return null;
      }
      const relative = match[1];
      if (!relative) {
        return null;
      }
      return relative;
    };

    const matches = content.matchAll(/"([^"\r\n]*)"/g);
    for (const match of matches) {
      const token = match[1] ?? "";
      const relative = extractRelativeFromToken(token);
      if (!relative) {
        continue;
      }

      const normalizedRelative = relative
        .trim()
        .replace(/[\\/]+/g, path.sep)
        .replace(/^[\\/]+/, "");
      const candidate = path.resolve(path.dirname(wrapperPath), normalizedRelative);
      if (isFilePath(candidate)) {
        candidates.push(candidate);
      }
    }

    const nonNode = candidates.find((candidate) => {
      const base = path.basename(candidate).toLowerCase();
      return base !== "node.exe" && base !== "node";
    });
    if (nonNode) {
      return nonNode;
    }
  } catch {
    // Ignore unreadable shims; caller will throw a guided error.
  }

  return null;
}

export function resolveWindowsLobsterSpawn(
  execPath: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
): SpawnTarget {
  const resolvedExecPath = resolveWindowsExecutablePath(execPath, env);
  const ext = path.extname(resolvedExecPath).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") {
    return { command: resolvedExecPath, argv };
  }

  const scriptPath =
    resolveLobsterScriptFromCmdShim(resolvedExecPath) ??
    resolveLobsterScriptFromPackageJson(resolvedExecPath);
  if (!scriptPath) {
    throw new Error(
      `lobsterPath resolved to ${path.basename(resolvedExecPath)} wrapper, but no Node entrypoint could be resolved without shell execution. Configure pluginConfig.lobsterPath to lobster.exe.`,
    );
  }

  const entryExt = path.extname(scriptPath).toLowerCase();
  if (entryExt === ".exe") {
    return { command: scriptPath, argv, windowsHide: true };
  }
  return { command: process.execPath, argv: [scriptPath, ...argv], windowsHide: true };
}
