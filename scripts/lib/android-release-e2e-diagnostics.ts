import path from "node:path";

/** Public failure facts must never copy command arguments, app text or raw logs. */
export function androidReleaseCommandFacts(bin: string, args: string[], stderr: string) {
  const basename = path.basename(bin);
  const tool = ["adb", "avdmanager", "emulator", "aapt2", "apksigner", "node", "git"].includes(
    basename,
  )
    ? basename
    : "other";
  const command = args[0] === "-s" ? args.slice(2) : args;
  const operation =
    tool === "adb" &&
    ["shell", "exec-out", "pull", "install", "forward", "reverse", "emu", "logcat"].includes(
      command[0] ?? "",
    )
      ? command[0]
      : "other";
  return {
    tool,
    operation,
    permissionDenied: /permission denied/iu.test(stderr),
    missingFile: /no such file or directory/iu.test(stderr),
    deviceOffline: /device offline/iu.test(stderr),
    connectionReset: /connection reset/iu.test(stderr),
    failedToCopy: /failed to copy/iu.test(stderr),
    timeout: /timed out|timeout/iu.test(stderr),
  };
}

export function androidReleaseErrorFacts(error: unknown) {
  const names = ["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError", "AbortError"];
  const code: unknown =
    error instanceof Error ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
  return {
    class: error instanceof Error && names.includes(error.name) ? error.name : "unknown",
    code:
      typeof code === "string" &&
      ["ETIMEDOUT", "ABORT_ERR", "EPROCESSGROUP_CLEANUP_FAILED"].includes(code)
        ? code
        : undefined,
  };
}

export function androidReleaseNativeFacts(text: string) {
  const classes = [
    "AssertionError",
    "IllegalStateException",
    "NullPointerException",
    "StaleObjectException",
  ];
  return {
    class:
      classes.find((name) => new RegExp(`\\.${name}(?=[:\\s]|$)`, "u").test(text)) ?? "unknown",
    frames: [
      ...text.matchAll(
        /(AndroidReleaseWearTest|AndroidReleasePhoneTest|ReleaseValidationUi)\.kt:(\d+)/gu,
      ),
    ]
      .slice(0, 8)
      .map((match) => ({ file: `${match[1]}.kt`, line: Number(match[2]) })),
  };
}
