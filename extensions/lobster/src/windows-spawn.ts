import type {
  WindowsSpawnProgramCandidate,
  WindowsSpawnResolution,
} from "openclaw/plugin-sdk";
import {
  applyWindowsSpawnProgramPolicy as _applyPolicy,
  materializeWindowsSpawnProgram as _materialize,
  resolveWindowsSpawnProgramCandidate as _resolveCandidate,
} from "openclaw/plugin-sdk";

// Graceful fallback when plugin-sdk build lacks windows-spawn exports (#33514).
const resolveWindowsSpawnProgramCandidate: typeof _resolveCandidate =
  typeof _resolveCandidate === "function"
    ? _resolveCandidate
    : (p: { command: string }): WindowsSpawnProgramCandidate => ({
        command: p.command,
        leadingArgv: [],
        resolution: "direct",
      });

const applyWindowsSpawnProgramPolicy: typeof _applyPolicy =
  typeof _applyPolicy === "function"
    ? _applyPolicy
    : (p) => ({
        command: p.candidate.command,
        leadingArgv: p.candidate.leadingArgv,
        resolution: p.candidate.resolution as WindowsSpawnResolution,
        shell: p.candidate.resolution === "unresolved-wrapper" ? true : undefined,
        windowsHide: p.candidate.windowsHide,
      });

const materializeWindowsSpawnProgram: typeof _materialize =
  typeof _materialize === "function"
    ? _materialize
    : (program, argv) => ({
        command: program.command,
        argv: [...program.leadingArgv, ...argv],
        resolution: program.resolution,
        shell: program.shell,
        windowsHide: program.windowsHide,
      });

type SpawnTarget = {
  command: string;
  argv: string[];
  windowsHide?: boolean;
};

export function resolveWindowsLobsterSpawn(
  execPath: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
): SpawnTarget {
  const candidate = resolveWindowsSpawnProgramCandidate({
    command: execPath,
    env,
    packageName: "lobster",
  });
  const program = applyWindowsSpawnProgramPolicy({
    candidate,
    allowShellFallback: false,
  });
  const resolved = materializeWindowsSpawnProgram(program, argv);
  if (resolved.shell) {
    throw new Error("lobster wrapper resolved to shell fallback unexpectedly");
  }
  return {
    command: resolved.command,
    argv: resolved.argv,
    windowsHide: resolved.windowsHide,
  };
}
