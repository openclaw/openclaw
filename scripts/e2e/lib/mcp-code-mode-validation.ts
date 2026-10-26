type McpCodeModeEvent =
  | { kind: "call"; callId: string; name: string; args: Record<string, unknown> }
  | { kind: "result"; callId: string; isError: boolean; output: unknown };

// This helper also runs from the packaged Docker client without workspace dependencies.
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content
        .map((block) => record(block).text)
        .filter((value) => typeof value === "string")
        .join("\n")
    : "";
}

function parseJson(output: unknown): unknown {
  if (typeof output !== "string") {
    return output;
  }
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

function parseOutput(output: unknown): Record<string, unknown> {
  const parsed = parseJson(output);
  if (!Array.isArray(parsed)) {
    return record(parsed);
  }
  // Codex native exec/wait returns a status header followed by content items,
  // not the OpenClaw JSON envelope. Failed/terminated headers never prove success.
  const header = text([parsed[0]]);
  const cellId = /^Script running with cell ID ([^\s\n]+)/u.exec(header)?.[1];
  if (cellId) {
    return { status: "waiting", runId: cellId };
  }
  if (header.startsWith("Script completed\n")) {
    for (const item of parsed.slice(1).toReversed()) {
      const value = parseJson(text([item]));
      if (value !== undefined) {
        return { status: "completed", value };
      }
    }
  }
  return {};
}

function callArgs(value: unknown): Record<string, unknown> {
  const args = record(value);
  // The Codex transcript projector preserves function arguments as serialized JSON.
  return typeof args.arguments === "string" ? record(parseJson(args.arguments)) : args;
}

function requestOutputs(
  request: Record<string, unknown>,
  attemptMarker: string,
): { output: unknown; isError: boolean }[] {
  const input = record(request.body).input;
  if (!Array.isArray(input)) {
    return [{ output: request.toolOutput, isError: request.toolOutputStructuredError === true }];
  }
  const start = input.findLastIndex((item) => record(item).role === "user");
  if (start < 0 || !hasAttemptMarker(text(record(input[start]).content), attemptMarker)) {
    return [];
  }
  // Snapshot toolOutput flattens native content items. Preserve their status header
  // and every same-ID output so the matcher can reject conflicting observations.
  return input
    .slice(start + 1)
    .filter((item) => {
      const entry = record(item);
      return (
        (entry.type === "function_call_output" || entry.type === "custom_tool_call_output") &&
        entry.call_id === request.toolOutputCallId
      );
    })
    .map((item) => {
      const entry = record(item);
      // The snapshot flag describes only its latest output, not every retained item.
      return {
        output: entry.output,
        isError:
          [entry.is_error, entry.isError].find((value) => typeof value === "boolean") === true,
      };
    });
}

function hasAttemptMarker(value: string, marker: string): boolean {
  const index = value.indexOf(marker);
  const end = index + marker.length;
  return marker.length > 0 && index >= 0 && (end === value.length || /\s/u.test(value.charAt(end)));
}

export function extractMcpCodeModeTranscriptEvidence(
  transcriptEvents: readonly unknown[],
  attemptMarker: string,
): McpCodeModeEvent[] {
  const messages = transcriptEvents.map((event) => record(record(event).message));
  const start = messages.findLastIndex((message) => message.role === "user");
  if (start < 0 || !hasAttemptMarker(text(messages[start]?.content), attemptMarker)) {
    return [];
  }
  const evidence: McpCodeModeEvent[] = [];
  for (const message of messages.slice(start + 1)) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const value of message.content) {
        const block = record(value);
        if (
          ["toolCall", "tool_use", "tool_call"].includes(String(block.type)) &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          evidence.push({
            kind: "call",
            callId: block.id,
            name: block.name,
            args: callArgs(block.arguments ?? block.input),
          });
        }
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      evidence.push({
        kind: "result",
        callId: message.toolCallId,
        isError: message.isError === true,
        output: message.details ?? text(message.content),
      });
    }
  }
  return evidence;
}

/** Requests are already bounded by the caller's pre-attempt provider cursor. */
export function extractMcpCodeModeRequestEvidence(
  requests: readonly unknown[],
  attemptMarker: string,
): McpCodeModeEvent[] {
  const evidence: McpCodeModeEvent[] = [];
  for (const value of requests) {
    const request = record(value);
    if (typeof request.prompt !== "string" || !hasAttemptMarker(request.prompt, attemptMarker)) {
      continue;
    }
    // A request consumes the previous result before planning its next call.
    if (typeof request.toolOutputCallId === "string" && request.toolOutputCallId) {
      for (const result of requestOutputs(request, attemptMarker)) {
        evidence.push({
          kind: "result",
          callId: request.toolOutputCallId,
          ...result,
        });
      }
    }
    if (
      typeof request.plannedToolCallId === "string" &&
      typeof request.plannedToolName === "string"
    ) {
      evidence.push({
        kind: "call",
        callId: request.plannedToolCallId,
        name: request.plannedToolName,
        args: callArgs(request.plannedToolArgs),
      });
    }
  }
  return evidence;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isFixtureCode(code: unknown): boolean {
  return (
    typeof code === "string" &&
    /\bAPI\.list\(\s*["']mcp["']\s*\)/u.test(code) &&
    /\bAPI\.read\(\s*["']mcp\/index\.d\.ts["']\s*\)/u.test(code) &&
    /\bAPI\.read\(\s*["']mcp\/fixture\.d\.ts["']\s*\)/u.test(code) &&
    /\bMCP\.fixture\.lookupNote\(\s*\{\s*id:\s*["']alpha["']/u.test(code)
  );
}

function isFixtureValue(value: unknown): boolean {
  const payload = record(value);
  return (
    payload.marker === "MCP_CODE_MODE_FILE_TOOL_RESULT" &&
    Array.isArray(payload.files) &&
    payload.files.includes("mcp/index.d.ts") &&
    payload.files.includes("mcp/fixture.d.ts") &&
    payload.rootHasFixture === true &&
    payload.headerHasLookup === true &&
    (payload.note ?? payload.resultText) === "fixture-note-alpha"
  );
}

export function validateMcpCodeModeResult(
  response: unknown,
  evidence: readonly McpCodeModeEvent[],
) {
  const output = record(response).output;
  const finalText = Array.isArray(output)
    ? output
        .filter((item) => record(item).type === "message")
        .map((item) => text(record(item).content))
        .join("\n")
    : "";
  assert(
    finalText.includes("MCP_CODE_MODE_FILE_OK") && finalText.includes("fixture-note-alpha"),
    "agent did not complete MCP API file check",
  );
  assert(
    !/MCP\s+(?:was\s+)?not\s+defined|failed|error/i.test(finalText),
    "agent reported MCP failure instead of a successful call",
  );

  const seen = new Map<string, string>();
  const calls = new Map<string, { execCallId: string; runId?: string }>();
  const waiting = new Map<string, string>();
  const matched = new Map<string, string>();
  for (const event of evidence) {
    assert(event.callId.length > 0, "missing code-mode call identity");
    const key = `${event.kind}:${event.callId}`;
    const serialized = JSON.stringify(event);
    const previous = seen.get(key);
    assert(
      previous === undefined || previous === serialized,
      "conflicting code-mode call evidence",
    );
    if (previous !== undefined) {
      continue;
    }
    seen.set(key, serialized);
    if (event.kind === "call") {
      const code =
        [event.args.command, event.args.code, event.args.input].find(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        ) ?? "";
      const waitId = event.args.cell_id ?? event.args.runId ?? event.args.run_id;
      assert(
        typeof event.args.code !== "string" ||
          !event.args.code.trim() ||
          typeof event.args.command !== "string" ||
          !event.args.command.trim() ||
          event.args.code.trim() === event.args.command.trim(),
        "conflicting code-mode source aliases",
      );
      assert(!code.includes("MCP.$api"), "agent should not call MCP.$api");
      assert(
        event.name !== "catalog.search" && !/catalog\.search\(\s*["']lookup note/u.test(code),
        "agent should not use catalog.search for MCP lookup",
      );
      if (event.name === "exec" && isFixtureCode(code)) {
        calls.set(event.callId, { execCallId: event.callId });
      } else if (event.name === "wait" && typeof waitId === "string") {
        const runId = waitId.trim();
        const execCallId = waiting.get(runId);
        if (execCallId) {
          calls.set(event.callId, { execCallId, runId });
          waiting.delete(runId);
        }
      }
      continue;
    }
    const call = calls.get(event.callId);
    if (!call || event.isError) {
      continue;
    }
    const result = parseOutput(event.output);
    if (call.runId && result.runId !== undefined && result.runId !== call.runId) {
      continue;
    }
    if (result.status === "waiting" && typeof result.runId === "string" && result.runId) {
      assert(!waiting.has(result.runId), "ambiguous code-mode continuation");
      waiting.set(result.runId, call.execCallId);
    } else if (result.status === "completed" && isFixtureValue(result.value)) {
      matched.set(event.callId, call.execCallId);
    }
  }
  assert(matched.size > 0, "no matched successful MCP code-mode completion for this attempt");
  return {
    finalText,
    matchedExecCallIds: [...new Set(matched.values())],
    matchedCompletionCallIds: [...matched.keys()],
  };
}
