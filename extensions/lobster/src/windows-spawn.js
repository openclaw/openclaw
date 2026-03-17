import {
  applyWindowsSpawnProgramPolicy,
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgramCandidate
} from "openclaw/plugin-sdk/lobster";
function resolveWindowsLobsterSpawn(execPath, argv, env) {
  const candidate = resolveWindowsSpawnProgramCandidate({
    command: execPath,
    env,
    packageName: "lobster"
  });
  const program = applyWindowsSpawnProgramPolicy({
    candidate,
    allowShellFallback: false
  });
  const resolved = materializeWindowsSpawnProgram(program, argv);
  if (resolved.shell) {
    throw new Error("lobster wrapper resolved to shell fallback unexpectedly");
  }
  return {
    command: resolved.command,
    argv: resolved.argv,
    windowsHide: resolved.windowsHide
  };
}
export {
  resolveWindowsLobsterSpawn
};
