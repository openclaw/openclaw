import path from "node:path";

/** Public failure facts must never copy command arguments, app text or raw logs. */
export function androidReleaseCommandFacts(
  bin: string,
  args: string[],
  stdout: string,
  stderr: string,
) {
  const output = `${stdout}\n${stderr}`;
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
    permissionDenied: /permission denied/iu.test(output),
    missingFile: /no such file or directory/iu.test(output),
    deviceOffline: /device offline/iu.test(output),
    connectionReset: /connection reset/iu.test(output),
    failedToCopy: /failed to copy/iu.test(output),
    timeout: /timed out|timeout/iu.test(output),
    transportClosed:
      tool === "adb" && /\b(?:error:[^\r\n]*\bclosed|connection closed)\b/iu.test(output),
    deviceMissing:
      tool === "adb" &&
      /\bdevice\b[^\r\n]*\bnot found\b|no devices\/emulators found/iu.test(output),
    remoteStatFailure:
      tool === "adb" &&
      /failed to stat remote object|remote object[^\r\n]*does not exist/iu.test(output),
    protocolFault: tool === "adb" && /protocol fault/iu.test(output),
    noSpace: tool === "adb" && /no space left on device/iu.test(output),
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
    processCrashed: /INSTRUMENTATION_RESULT: shortMsg=Process crashed(?:\.|\r?\n|$)/u.test(text),
    instrumentationFailed: /INSTRUMENTATION_FAILED/u.test(text),
    OKsingle: /OK \(1 test\)/u.test(text),
    phaseReady: {
      initial: /OPENCLAW_ANDROID_PHASE_READY initial(?:\r?\n|$)/u.test(text),
      relaunch: /OPENCLAW_ANDROID_PHASE_READY relaunch(?:\r?\n|$)/u.test(text),
      "phone-restart": /OPENCLAW_ANDROID_PHASE_READY phone-restart(?:\r?\n|$)/u.test(text),
      "long-reply": /OPENCLAW_ANDROID_PHASE_READY long-reply(?:\r?\n|$)/u.test(text),
      reader: /OPENCLAW_ANDROID_PHASE_READY reader(?:\r?\n|$)/u.test(text),
    },
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
