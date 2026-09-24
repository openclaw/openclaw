import { randomUUID } from "node:crypto";
import type { AgentOutputOptions, CommandResult } from "./config.ts";
import { CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS } from "./config.ts";
import { readLogFileSize, readLogTextSince, readLogTextTail } from "./logs.ts";

export async function runReleaseAgentTurn(
  params: { label: string; logPath: string },
  run: (args: string[], timeoutMs: number) => Promise<CommandResult>,
): Promise<CommandResult> {
  const sessionId = buildCrossOsReleaseAgentSessionId(params.label);
  // Only output from this invocation can satisfy the live probe.
  const logOffset = readLogFileSize(params.logPath);
  const result = await run(
    buildReleaseAgentTurnArgs(sessionId),
    (CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS + 60) * 1000,
  );
  const logText = readLogTextSince(params.logPath, logOffset);
  if (!agentOutputHasExpectedOkMarker(result.stdout, { logText })) {
    throw new Error("Agent output did not contain the expected OK marker.");
  }
  return result;
}

export function buildCrossOsReleaseAgentSessionId(label: string) {
  return `cross-os-release-check-${label}-${randomUUID()}`;
}

export function buildReleaseAgentTurnArgs(sessionId: string) {
  return [
    "agent",
    "--agent",
    "main",
    "--session-id",
    sessionId,
    "--message",
    "Reply with exact ASCII text OK only.",
    "--thinking",
    "off",
    "--timeout",
    String(CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS),
    "--json",
  ];
}

export function agentOutputHasExpectedOkMarker(stdout: string, options: AgentOutputOptions = {}) {
  const payloadTexts = parseAgentPayloadTexts(stdout);
  if (payloadTexts.some((text) => text.trim() === "OK")) {
    return true;
  }
  if (typeof options.logText === "string") {
    const logTexts = parseAgentPayloadTexts(options.logText);
    return logTexts.some((text) => text.trim() === "OK");
  }
  if (typeof options.logPath !== "string") {
    return false;
  }
  const logTexts = parseAgentPayloadTexts(readLogTextTail(options.logPath));
  return logTexts.some((text) => text.trim() === "OK");
}

function parseAgentPayloadTexts(stdout: string) {
  try {
    type AgentPayload = {
      text?: string;
      finalAssistantVisibleText?: string;
      finalAssistantRawText?: string;
      meta?: AgentPayload;
      result?: AgentPayload;
      payloads?: AgentPayload[];
    };
    const payload = JSON.parse(stdout) as AgentPayload;
    const directTexts = [
      payload?.finalAssistantVisibleText,
      payload?.finalAssistantRawText,
      payload?.meta?.finalAssistantVisibleText,
      payload?.meta?.finalAssistantRawText,
      payload?.result?.finalAssistantVisibleText,
      payload?.result?.finalAssistantRawText,
      payload?.result?.meta?.finalAssistantVisibleText,
      payload?.result?.meta?.finalAssistantRawText,
    ].filter((text): text is string => typeof text === "string");
    const entries = Array.isArray(payload?.payloads)
      ? payload.payloads
      : Array.isArray(payload?.result?.payloads)
        ? payload.result.payloads
        : [];
    const payloadTexts = entries.flatMap((entry) =>
      typeof entry?.text === "string" ? [entry.text] : [],
    );
    return [...directTexts, ...payloadTexts];
  } catch {
    const finalTextMatches = [
      ...stdout.matchAll(
        /"(?:finalAssistantVisibleText|finalAssistantRawText|text)"\s*:\s*"([^"]*)"/gu,
      ),
    ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
    return finalTextMatches.length > 0 ? finalTextMatches : stdout.trim() ? [stdout] : [];
  }
}
