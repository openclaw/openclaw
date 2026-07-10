import { spawnSync } from "node:child_process";

const REQUIRED_AGY_FLAGS = ["--print", "--model", "--print-timeout"] as const;

export type AgyProbeResult =
  | { ok: true; helpText: string }
  | { ok: false; reason: string };

export type AgyHelpRunner = () => {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
};

function toText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  return value ? value.toString("utf8") : "";
}

function runAgyHelp(): ReturnType<AgyHelpRunner> {
  return spawnSync("agy", ["--help"], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
}

export function probeAgy(runner: AgyHelpRunner = runAgyHelp): AgyProbeResult {
  const result = runner();
  if (result.error) {
    return {
      ok: false,
      reason: `Unable to execute agy --help: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    const stderr = toText(result.stderr).trim();
    return {
      ok: false,
      reason: stderr
        ? `agy --help exited with status ${String(result.status)}: ${stderr}`
        : `agy --help exited with status ${String(result.status)}`,
    };
  }

  const helpText = [toText(result.stdout), toText(result.stderr)].join("\n").trim();
  const missingFlags = REQUIRED_AGY_FLAGS.filter((flag) => !helpText.includes(flag));
  if (missingFlags.length > 0) {
    return {
      ok: false,
      reason: `agy --help is missing required flags: ${missingFlags.join(", ")}`,
    };
  }

  return { ok: true, helpText };
}
