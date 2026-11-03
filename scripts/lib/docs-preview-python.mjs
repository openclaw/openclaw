import { spawnSync } from "node:child_process";

// Windows Python installers expose different launchers; never accept Python 2.
export function resolvePreviewPython(
  platform = process.platform,
  probe = (command, args) => spawnSync(command, args, { encoding: "utf8", timeout: 5_000 }),
) {
  const candidates =
    platform === "win32"
      ? [
          { command: "py", args: ["-3"] },
          { command: "python", args: [] },
          { command: "python3", args: [] },
        ]
      : [{ command: "python3", args: [] }];
  for (const candidate of candidates) {
    const result = probe(candidate.command, [
      ...candidate.args,
      "-c",
      "import sys; print(sys.version_info[0])",
    ]);
    if (!result.error && result.status === 0 && result.stdout.trim() === "3") {
      return candidate;
    }
  }
  throw new Error(
    "Python 3 is required to serve the docs preview. Install Python 3, or use --build-only and serve the output yourself.",
  );
}
