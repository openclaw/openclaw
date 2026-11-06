export const EXEC_AUTO_REVIEW_GUIDANCE =
  "An automatic reviewer may deny a command and explain why; if denied, choose a materially safer alternative or ask the user, never work around the denial.";

export function describeExecTool(params?: {
  hasCronTool?: boolean;
  hasProcessTool?: boolean;
  autoReview?: boolean;
}): string {
  const continuation =
    params?.hasProcessTool === false
      ? ["Run shell and wait for completion."]
      : [
          "Run shell now; background continuation supported.",
          "Completed calls return command output directly. Use process only when exec reports running with a sessionId; output text alone is not a process handle.",
          "Long run: automatic completion wake, when enabled, occurs only after exit; otherwise process confirms completion. Output while still running does not automatically start another turn. Background commands can outlive the turn; use process kill when no longer needed. Completion and the configured timeout still apply; this is not a saved, restartable automation.",
        ];
  const base = [
    params?.hasCronTool
      ? "For continuous monitoring with future alerts, check automations for supported saved watchers. Ordinary background output cannot wake you to report new events."
      : undefined,
    ...continuation,
    "Omit host/node to use the session's configured host.",
    params?.hasCronTool ? "No sleep loops for reminders/follow-ups; use automations." : undefined,
    "TTY CLI/UI/coding agent: pty=true.",
  ]
    .filter(Boolean)
    .join(" ");
  const description =
    process.platform !== "win32"
      ? `${base} Quote arguments containing shell metacharacters, including URL query strings with \`?\` or \`&\`.`
      : `${base}\nIMPORTANT (Windows): Run executables directly; do NOT wrap commands in \`cmd /c\`, \`powershell -Command\`, \`& \` prefix, or WSL. Use backslash paths (C:\\path), not forward slashes. Use short executable names (e.g. \`node\`, \`python3\`) instead of full paths.`;
  return params?.autoReview ? `${description} ${EXEC_AUTO_REVIEW_GUIDANCE}` : description;
}

export function describeProcessTool(params?: { hasCronTool?: boolean }): string {
  return [
    "Control existing exec: list, poll, log, write, send-keys, submit, paste, kill.",
    "poll/log: status, output, quiet success, completion without auto-wake, input hints. Others: input/intervention.",
    "kill requests termination or returns the retained terminal result for an already-finished session. After a termination request, poll until a terminal result confirms exit and cleanup before saying stopped. A running poll is still pending. remove hides the record and cannot confirm cleanup.",
    "Later process results supersede turn-start snapshots. Control sessions by sessionId; a displayed host PID is not a portable sandbox PID.",
    params?.hasCronTool
      ? "No polling as timer/reminder; scheduled follow-up uses automations. On a requested monitoring stop, also stop any ordinary exec sessions you created for that request; stopping a saved automation does not stop them. Preserve unrelated work."
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}
