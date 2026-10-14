import { OPENCLAW_ACPX_LEASE_ID_ARG, OPENCLAW_GATEWAY_INSTANCE_ID_ARG } from "./process-lease.js";

export const RUN_CONFIGURED_COMMAND_SENTINEL = "--openclaw-run-configured";

type DiagnosticRedactionRuleSpec = {
  source: string;
  flags: string;
  replacement: string;
};

const DIAGNOSTIC_REDACTION_RULES: DiagnosticRedactionRuleSpec[] = [
  {
    source: String.raw`(authorization\s*[:=]\s*bearer\s+)[^\s'"<>]+`,
    flags: "gi",
    replacement: "$1[REDACTED]",
  },
  {
    source: String.raw`((?:api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|passwd|credential)\s*[:=]\s*)[^\s'"<>]+`,
    flags: "gi",
    replacement: "$1[REDACTED]",
  },
  {
    source: String.raw`("(?:apiKey|token|secret|password|passwd|accessToken|refreshToken)"\s*:\s*")[^"]+`,
    flags: "g",
    replacement: "$1[REDACTED]",
  },
  {
    source: String.raw`(["']?(?:api[-_]?key|apiKey|access[-_]?token|accessToken|refresh[-_]?token|refreshToken|id[-_]?token|idToken|auth[-_]?token|authToken|client[-_]?secret|clientSecret|app[-_]?secret|appSecret|token|secret|password|passwd|credential)["']?\s*[:=]\s*["']?)[^"',}\s<>]+`,
    flags: "gi",
    replacement: "$1[REDACTED]",
  },
  {
    source: String.raw`([?&](?:access[-_]?token|auth[-_]?token|refresh[-_]?token|api[-_]?key|client[-_]?secret|token|key|secret|password|pass|passwd|auth|signature)=)[^&\s'"<>]+`,
    flags: "gi",
    replacement: "$1[REDACTED]",
  },
  {
    source: String.raw`(--(?:api[-_]?key|token|secret|password|passwd)\s+)[^\s'"]+`,
    flags: "gi",
    replacement: "$1[REDACTED]",
  },
  {
    source:
      String.raw`-----BEGIN [A-Z ]*PRI` +
      String.raw`VATE KEY-----[\s\S]+?-----END [A-Z ]*PRI` +
      String.raw`VATE KEY-----`,
    flags: "g",
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    source: String.raw`\b(sk-[A-Za-z0-9_-]{8,})\b`,
    flags: "g",
    replacement: "[REDACTED_OPENAI_KEY]",
  },
  {
    source: String.raw`\b(gh[pousr]_[A-Za-z0-9_]{20,})\b`,
    flags: "g",
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    source: String.raw`\b(github_pat_[A-Za-z0-9_]{20,})\b`,
    flags: "g",
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    source: String.raw`\b(xox[baprs]-[A-Za-z0-9-]{10,})\b`,
    flags: "g",
    replacement: "[REDACTED_SLACK_TOKEN]",
  },
  {
    source: String.raw`\b(gsk_[A-Za-z0-9_-]{10,})\b`,
    flags: "g",
    replacement: "[REDACTED_API_KEY]",
  },
  {
    source: String.raw`\b(AIza[0-9A-Za-z\-_]{20,})\b`,
    flags: "g",
    replacement: "[REDACTED_GOOGLE_KEY]",
  },
  {
    source: String.raw`\b(ya29\.[0-9A-Za-z_\-./+=]{10,})\b`,
    flags: "g",
    replacement: "[REDACTED_GOOGLE_TOKEN]",
  },
  {
    source: String.raw`\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b`,
    flags: "g",
    replacement: "[REDACTED_JWT]",
  },
  {
    source: String.raw`\b(pplx-[A-Za-z0-9_-]{10,})\b`,
    flags: "g",
    replacement: "[REDACTED_API_KEY]",
  },
  {
    source: String.raw`\b(npm_[A-Za-z0-9]{10,})\b`,
    flags: "g",
    replacement: "[REDACTED_NPM_TOKEN]",
  },
  {
    source: String.raw`\b(LTAI[A-Za-z0-9]{10,})\b`,
    flags: "g",
    replacement: "[REDACTED_ACCESS_KEY]",
  },
  { source: String.raw`\b(hf_[A-Za-z0-9]{10,})\b`, flags: "g", replacement: "[REDACTED_API_KEY]" },
  {
    source: String.raw`\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b`,
    flags: "g",
    replacement: "bot[REDACTED_TELEGRAM_TOKEN]",
  },
  {
    source: String.raw`\b(\d{6,}:[A-Za-z0-9_-]{20,})\b`,
    flags: "g",
    replacement: "[REDACTED_TELEGRAM_TOKEN]",
  },
];

export function buildAdapterWrapperScript(params: {
  displayName: string;
  packageSpec: string;
  binName: string;
  installedBinPath?: string;
  envSetup: string;
  envConfigSetup?: string;
  openClawWrapperArgs?: string[];
  stderrLogFileNamePrefix?: string;
}): string {
  return `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

function main() {
${params.envSetup}
const stderrLogFileNamePrefix = ${params.stderrLogFileNamePrefix ? JSON.stringify(params.stderrLogFileNamePrefix) : "undefined"};
const stderrLogMaxChars = 256 * 1024;

const openClawWrapperArgs = new Set([
  ${JSON.stringify(OPENCLAW_ACPX_LEASE_ID_ARG)},
  ${JSON.stringify(OPENCLAW_GATEWAY_INSTANCE_ID_ARG)},
  ${(params.openClawWrapperArgs ?? []).map((arg) => JSON.stringify(arg)).join(",\n  ")}
]);

function readOpenClawWrapperArg(args, name) {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOpenClawWrapperArgs(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) {
      continue;
    }
    const value = args[index + 1];
    if (typeof value === "string" && value.trim()) {
      values.push(value.trim());
    }
    index += 1;
  }
  return values;
}

function safeDiagnosticFilePart(value) {
  const sanitized = String(value || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return sanitized || "pid-" + process.pid;
}

function resolveStderrLogPath(args) {
  if (!stderrLogFileNamePrefix) {
    return undefined;
  }
  const leaseId =
    readOpenClawWrapperArg(args, ${JSON.stringify(OPENCLAW_ACPX_LEASE_ID_ARG)}) ||
    "pid-" + process.pid;
  const fileName = stderrLogFileNamePrefix + "." + safeDiagnosticFilePart(leaseId) + ".log";
  return fileURLToPath(new URL("./" + fileName, import.meta.url));
}

const diagnosticRedactionRules = ${JSON.stringify(DIAGNOSTIC_REDACTION_RULES)}.map((rule) => [
  new RegExp(rule.source, rule.flags),
  rule.replacement,
]);

function redactDiagnosticText(text) {
  let redacted = text;
  for (const [pattern, replacement] of diagnosticRedactionRules) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function tailUtf16Safe(text, maxChars) {
  let start = Math.max(0, text.length - maxChars);
  const startsInsideSurrogatePair =
    start > 0 &&
    start < text.length &&
    text.charCodeAt(start) >= 0xdc00 &&
    text.charCodeAt(start) <= 0xdfff &&
    text.charCodeAt(start - 1) >= 0xd800 &&
    text.charCodeAt(start - 1) <= 0xdbff;
  if (startsInsideSurrogatePair) {
    start += 1;
  }
  return text.slice(start);
}

let pendingStderrLogText = "";
// Pipe chunks can split a UTF-8 sequence. Preserve decoder state so diagnostic
// capture does not manufacture replacement characters between chunks.
const stderrDecoder = new StringDecoder("utf8");
const stderrPrivateKeyEndPattern = /-----END [A-Z ]*PRIVATE KEY-----/;

function hasUnclosedPrivateKeyBlock(text) {
  let lastBeginIndex = -1;
  for (const match of text.matchAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g)) {
    lastBeginIndex = match.index ?? lastBeginIndex;
  }
  if (lastBeginIndex === -1) {
    return -1;
  }
  return stderrPrivateKeyEndPattern.test(text.slice(lastBeginIndex)) ? -1 : lastBeginIndex;
}

function writeRedactedStderrLog(text) {
  if (!stderrLogPath) {
    return;
  }
  if (!text) {
    return;
  }
  try {
    appendFileSync(stderrLogPath, redactDiagnosticText(text), "utf8");
    const current = readFileSync(stderrLogPath, "utf8");
    if (current.length > stderrLogMaxChars) {
      writeFileSync(stderrLogPath, tailUtf16Safe(current, stderrLogMaxChars), "utf8");
    }
  } catch {
    // Stderr capture is diagnostic-only; never break the ACP adapter.
  }
}

function redactIncompletePrivateKeyTail(text) {
  const unclosedPrivateKeyStart = hasUnclosedPrivateKeyBlock(text);
  if (unclosedPrivateKeyStart === -1) {
    return text;
  }
  return text.slice(0, unclosedPrivateKeyStart) + "[REDACTED_PRIVATE_KEY]";
}

function flushFinalizedStderrLogText() {
  const lastLineBreak = pendingStderrLogText.lastIndexOf("\\n");
  if (lastLineBreak === -1) {
    if (pendingStderrLogText.length > stderrLogMaxChars) {
      pendingStderrLogText = tailUtf16Safe(pendingStderrLogText, stderrLogMaxChars);
    }
    return;
  }
  let flushEnd = lastLineBreak + 1;
  const unclosedPrivateKeyStart = hasUnclosedPrivateKeyBlock(
    pendingStderrLogText.slice(0, flushEnd),
  );
  if (unclosedPrivateKeyStart !== -1) {
    flushEnd = unclosedPrivateKeyStart;
  }
  if (flushEnd <= 0) {
    if (pendingStderrLogText.length > stderrLogMaxChars) {
      pendingStderrLogText = tailUtf16Safe(pendingStderrLogText, stderrLogMaxChars);
    }
    return;
  }
  const finalizedText = pendingStderrLogText.slice(0, flushEnd);
  pendingStderrLogText = pendingStderrLogText.slice(flushEnd);
  writeRedactedStderrLog(finalizedText);
}

function appendStderrLog(chunk) {
  const text = stderrDecoder.write(chunk);
  if (!text) {
    return;
  }
  pendingStderrLogText += text;
  flushFinalizedStderrLogText();
}

function finishStderrLog() {
  pendingStderrLogText += stderrDecoder.end();
  const text = redactIncompletePrivateKeyTail(pendingStderrLogText);
  pendingStderrLogText = "";
  writeRedactedStderrLog(text);
}

function stripOpenClawWrapperArgs(args) {
  const stripped = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (openClawWrapperArgs.has(value)) {
      index += 1;
      continue;
    }
    stripped.push(value);
  }
  return stripped;
}

const rawConfiguredArgs = process.argv.slice(2);
${params.envConfigSetup ?? ""}
const stderrLogPath = resolveStderrLogPath(rawConfiguredArgs);
if (stderrLogPath) {
  try {
    rmSync(stderrLogPath, { force: true });
  } catch {
    // Diagnostic cleanup must never prevent the adapter from starting.
  }
}

const configuredArgs = stripOpenClawWrapperArgs(rawConfiguredArgs);

function resolveNpmCliPath() {
  const candidate = path.resolve(
    path.dirname(process.execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  return existsSync(candidate) ? candidate : undefined;
}

const npmCliPath = resolveNpmCliPath();
const installedBinPath = ${params.installedBinPath ? JSON.stringify(params.installedBinPath) : "undefined"};
let defaultCommand;
let defaultArgs;
// Plugin capture/install directories are disposable: a durable wrapper can
// outlive the path it captured, so re-check the target before trusting it.
if (installedBinPath && existsSync(installedBinPath)) {
  defaultCommand = process.execPath;
  defaultArgs = [installedBinPath];
} else if (npmCliPath) {
  defaultCommand = process.execPath;
  defaultArgs = [npmCliPath, "exec", "--yes", "--package", "${params.packageSpec}", "--", "${params.binName}"];
} else {
  defaultCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  defaultArgs = ["--yes", "--package", "${params.packageSpec}", "--", "${params.binName}"];
}
const command =
  configuredArgs[0] === "${RUN_CONFIGURED_COMMAND_SENTINEL}" ? configuredArgs[1] : defaultCommand;
const args =
  configuredArgs[0] === "${RUN_CONFIGURED_COMMAND_SENTINEL}"
    ? configuredArgs.slice(2)
    : [...defaultArgs, ...configuredArgs];

if (!command) {
  console.error("[openclaw] missing configured ${params.displayName} ACP command");
  process.exitCode = 1;
  return;
}

const child = spawn(command, args, {
  detached: process.platform !== "win32",
  env,
  stdio: ["inherit", "inherit", "pipe"],
  windowsHide: true,
});

child.stderr?.on("data", (chunk) => {
  appendStderrLog(chunk);
  process.stderr.write(chunk);
});

let forceKillTimer;
let orphanCleanupStarted = false;
let childExitCode = 1;
let childFailed = false;
let childClosed = false;

function finishWrapper() {
  if (!childClosed || forceKillTimer) {
    return;
  }
  for (const [signal, listener] of signalListeners) {
    process.off(signal, listener);
  }
  process.exitCode = childFailed ? 1 : childExitCode;
}

function killChildTree(signal, options = {}) {
  if (!child.pid || (!options.force && child.killed)) {
    return;
  }
  if (process.platform !== "win32") {
    try {
      // The adapter can spawn grandchildren; signaling the process group keeps
      // the generated wrapper from leaving an ACP tree behind.
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to direct child signaling below.
    }
  }
  child.kill(signal);
}

const signalListeners = new Map();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const listener = () => killChildTree(signal);
  signalListeners.set(signal, listener);
  process.on(signal, listener);
}

const originalParentPid = process.ppid;
const parentWatcher =
  process.platform === "win32"
    ? undefined
    : setInterval(() => {
        // Orphan detection: parent PID changed means our original parent died.
        // The new parent could be PID 1 (init) on bare-metal hosts, OR a
        // systemd user-session manager, OR a container init, OR a session
        // leader — depending on environment. Previously this only triggered
        // on PPID == 1, which missed all systemd-managed deployments and
        // leaked codex-acp adapter trees on every gateway restart.
        if (process.ppid === originalParentPid) {
          return;
        }
        if (orphanCleanupStarted) {
          return;
        }
        orphanCleanupStarted = true;
        if (parentWatcher) {
          clearInterval(parentWatcher);
        }
        killChildTree("SIGTERM");
        // Keep the wrapper alive long enough for stubborn adapters to receive
        // a forced fallback signal after SIGTERM.
        forceKillTimer = setTimeout(() => {
          try {
            killChildTree("SIGKILL", { force: true });
          } finally {
            forceKillTimer = undefined;
            childExitCode = 1;
            finishWrapper();
          }
        }, 1_500);
      }, 1_000);
parentWatcher?.unref?.();

child.on("error", (error) => {
  console.error(\`[openclaw] failed to launch ${params.displayName} ACP wrapper: \${error.message}\`);
  childFailed = true;
});

child.on("exit", (code, signal) => {
  // Descendants can retain stdio after the direct child exits. Keep watching
  // the wrapper parent until close, including after this status notification.
  if (orphanCleanupStarted) {
    return;
  }
  if (code !== null) {
    childExitCode = code;
    return;
  }
  childExitCode = signal ? 1 : 0;
});

child.on("close", () => {
  finishStderrLog();
  if (parentWatcher) {
    clearInterval(parentWatcher);
  }
  childClosed = true;
  finishWrapper();
});
}
main();
`;
}
