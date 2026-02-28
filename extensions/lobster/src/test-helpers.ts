import fs from "node:fs/promises";
import path from "node:path";

type PathEnvKey = "PATH" | "Path" | "PATHEXT" | "Pathext";

const PATH_ENV_KEYS = ["PATH", "Path", "PATHEXT", "Pathext"] as const;

export type PlatformPathEnvSnapshot = {
  platformDescriptor: PropertyDescriptor | undefined;
  env: Record<PathEnvKey, string | undefined>;
};

export function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

export function snapshotPlatformPathEnv(): PlatformPathEnvSnapshot {
  return {
    platformDescriptor: Object.getOwnPropertyDescriptor(process, "platform"),
    env: {
      PATH: process.env.PATH,
      Path: process.env.Path,
      PATHEXT: process.env.PATHEXT,
      Pathext: process.env.Pathext,
    },
  };
}

export function restorePlatformPathEnv(snapshot: PlatformPathEnvSnapshot): void {
  if (snapshot.platformDescriptor) {
    Object.defineProperty(process, "platform", snapshot.platformDescriptor);
  }

  for (const key of PATH_ENV_KEYS) {
    const value = snapshot.env[key];
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

export async function createWindowsCmdShimFixture(params: {
  shimPath: string;
  scriptPath: string;
  shimLine: string;
}): Promise<void> {
  await fs.mkdir(path.dirname(params.scriptPath), { recursive: true });
  await fs.mkdir(path.dirname(params.shimPath), { recursive: true });
  await fs.writeFile(params.scriptPath, "module.exports = {};\n", "utf8");
  await fs.writeFile(params.shimPath, `@echo off\r\n${params.shimLine}\r\n`, "utf8");
}
