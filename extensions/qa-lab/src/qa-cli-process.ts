import path from "node:path";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { isRecord as isJsonRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  appendQaChildOutput,
  createQaChildOutputCapture,
  QA_CHILD_STDERR_TAIL_BYTES,
  QA_CHILD_STDOUT_MAX_BYTES,
  readQaChildOutput,
} from "./child-output.js";
import { QaSuiteInfraError } from "./errors.js";
import { resolveQaNodeExecPath } from "./node-exec.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\x1B\[[0-?]*[ -/]*[@-~]`, "g");

function parseBalancedJsonPayloadStart(text: string) {
  // Candidates have already been restricted to lines starting with { or [.
  const stack = [text[0] === "{" ? "}" : "]"];
  let inString = false;
  let escaping = false;
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
    } else if (char === "}" || char === "]") {
      if (stack.pop() !== char) {
        return undefined;
      }
      if (stack.length === 0) {
        try {
          return JSON.parse(text.slice(0, index + 1)) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function isStructuredDiagnosticJson(value: unknown) {
  if (!isJsonRecord(value)) {
    return false;
  }
  const level = value.level ?? value.logLevel ?? value.severity;
  if (typeof level !== "string") {
    return false;
  }
  return (
    typeof value.message === "string" ||
    typeof value.msg === "string" ||
    typeof value.time === "string" ||
    typeof value.timestamp === "string"
  );
}

function parseQaCliJsonOutput(text: string, args: readonly string[]) {
  const cleaned = text.replace(ANSI_ESCAPE_PATTERN, "").trim();
  if (!cleaned) {
    return {};
  }
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    // Some startup repair logs are emitted on stdout before command JSON.
    const lines = cleaned.split(/\r?\n/);
    const candidates: unknown[] = [];
    for (const [index, line] of lines.entries()) {
      const candidate = line.trimStart();
      if (candidate !== line || (!candidate.startsWith("{") && !candidate.startsWith("["))) {
        continue;
      }
      const jsonTail = lines.slice(index).join("\n");
      const balanced = parseBalancedJsonPayloadStart(jsonTail);
      if (balanced !== undefined) {
        candidates.push(balanced);
      }
    }
    const expectedPayload = candidates.find((value) => {
      if (!args.includes("--json") || args[0] !== "memory") {
        return false;
      }
      if (args[1] === "search") {
        return isJsonRecord(value) && Array.isArray(value.results);
      }
      return (
        args[1] === "status" &&
        (Array.isArray(value) ||
          (isJsonRecord(value) && value.command === "memory" && value.subcommand === "status"))
      );
    });
    if (expectedPayload !== undefined) {
      return expectedPayload;
    }
    if (candidates.length > 0) {
      const payload = candidates.findLast((value) => !isStructuredDiagnosticJson(value));
      return payload !== undefined ? payload : candidates.at(-1);
    }

    // Keep a line-oriented fallback for compact payloads followed by diagnostics.
    for (const line of lines.toReversed()) {
      const candidate = line.trim();
      if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
        continue;
      }
      try {
        return JSON.parse(candidate) as unknown;
      } catch {
        // Keep looking for the actual payload line.
      }
    }
    throw new Error(`qa cli returned non-JSON stdout: ${truncateUtf16Safe(cleaned, 240)}`);
  }
}

export async function runQaCli(
  env: Pick<QaSuiteRuntimeEnv, "gateway" | "repoRoot">,
  args: string[],
  opts?: { timeoutMs?: number; json?: boolean; env?: NodeJS.ProcessEnv },
) {
  const stdout = createQaChildOutputCapture();
  const command = env.gateway.cliCommand ?? {
    executablePath: await resolveQaNodeExecPath(),
    argsPrefix: [path.join(env.repoRoot, "dist", "index.js")],
    cwd: env.gateway.tempRoot,
  };
  const result = await runUtf8CommandWithTimeout(
    [command.executablePath, ...command.argsPrefix, ...args],
    {
      cwd: command.cwd,
      baseEnv: env.gateway.runtimeEnv,
      env: opts?.env,
      input: "",
      timeoutMs: resolveTimerTimeoutMs(opts?.timeoutMs, 60_000),
      killProcessTree: true,
      requireProcessTreeExtinction: true,
      killSignal: "SIGKILL",
      killGraceMs: 0,
      maxOutputBytes: QA_CHILD_STDERR_TAIL_BYTES,
      outputCapture: "tail",
      terminateOnOutputError: true,
      // Parse the full JSON head on success; the runner retains bounded tails through cleanup.
      onOutputChunk: (chunk, stream) => {
        if (stream === "stdout") {
          appendQaChildOutput(stdout, chunk);
        }
      },
    },
  );
  const diagnostic = (stream: "stdout" | "stderr") => {
    const text = result[stream].trim();
    return result[`${stream}TruncatedBytes`] && text
      ? `[qa cli ${stream} truncated to last ${QA_CHILD_STDERR_TAIL_BYTES} bytes]\n${text}`
      : text;
  };
  let error: Error | undefined;
  if (result.termination === "timeout") {
    const diagnostics = (["stdout", "stderr"] as const)
      .map((stream) => {
        const text = diagnostic(stream);
        return text ? `${stream}:\n${text}` : "";
      })
      .filter(Boolean)
      .join("\n");
    error = new QaSuiteInfraError(
      "qa_cli_timeout",
      `qa cli timed out: openclaw ${args.join(" ")}${diagnostics ? `\n${diagnostics}` : ""}`,
    );
  } else if (result.code !== 0) {
    error = new Error(`qa cli failed (${result.code ?? "unknown"}): ${diagnostic("stderr")}`);
  } else if (stdout.exceeded) {
    error = new Error(
      `qa cli stdout exceeded ${QA_CHILD_STDOUT_MAX_BYTES} bytes; refusing to parse truncated output`,
    );
  }
  if (result.cleanup === "uncertain") {
    const cleanup = new Error("qa cli settlement failed: process-tree cleanup unconfirmed");
    throw error
      ? new AggregateError([error, cleanup], "qa cli command and settlement failed")
      : cleanup;
  }
  if (error) {
    throw error;
  }
  const text = readQaChildOutput(stdout).trim();
  if (!opts?.json) {
    return text;
  }
  return parseQaCliJsonOutput(text, args);
}
