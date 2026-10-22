import path from "node:path";
import { executableFileExistsSync } from "openclaw/plugin-sdk/path-existence-runtime";

type CrabboxBinaryOptions = {
  cwd?: string;
  explicit?: string;
  isExecutable?: (candidate: string) => boolean;
  openclawRoot?: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
};

function binaryCandidates(base: string, platform: NodeJS.Platform): string[] {
  return platform === "win32"
    ? [".exe", ".cmd", ".bat", ".com", ""].map((suffix) => `${base}${suffix}`)
    : [base];
}

export function resolveCrabboxBinary(params: CrabboxBinaryOptions): string {
  return params.explicit || findCrabboxBinary(params) || "crabbox";
}

export function findCrabboxBinary(params: CrabboxBinaryOptions): string | undefined {
  const platform = params.platform ?? process.platform;
  const isExecutable =
    params.isExecutable ?? ((candidate) => executableFileExistsSync(candidate, platform));
  if (params.explicit) {
    const candidate = params.cwd ? path.resolve(params.cwd, params.explicit) : params.explicit;
    return isExecutable(candidate) ? params.explicit : undefined;
  }
  if (params.openclawRoot) {
    const siblingBase = path.resolve(
      params.cwd ?? ".",
      params.openclawRoot,
      "../crabbox/bin/crabbox",
    );
    for (const candidate of binaryCandidates(siblingBase, platform)) {
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  const delimiter = platform === "win32" ? ";" : ":";
  const executableNames = binaryCandidates("crabbox", platform);
  for (const directory of (params.pathEnv ?? "").split(delimiter)) {
    if (!directory) {
      continue;
    }
    for (const name of executableNames) {
      const candidate = path.resolve(params.cwd ?? ".", directory, name);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}
