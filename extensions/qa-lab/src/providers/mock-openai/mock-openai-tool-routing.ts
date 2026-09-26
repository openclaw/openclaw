import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
import type {
  MockOpenAiCodeModeExecSurface,
  ResponsesInputItem,
  StreamEvent,
} from "./mock-openai-contracts.js";
import { findNamedToolDefinition, hasToolDefinition } from "./mock-openai-directives.js";
import { extractPlannedToolArgs, extractPlannedToolName } from "./mock-openai-events.js";
import {
  extractToolOutput,
  extractToolOutputCallId,
  extractToolOutputStructuredError,
  parseToolOutputJson,
} from "./mock-openai-input.js";
import {
  buildCustomToolCallEventsWithInput,
  buildToolCallEventsWithArgs as buildRawToolCallEventsWithArgs,
} from "./mock-openai-tooling.js";

export const QA_CODE_MODE_TARGET_MARKER = "qa-code-mode-target:";

export function stringifyScenarioToolOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export function encodeCodeModeTarget(name: string, args: Record<string, unknown>) {
  return Buffer.from(JSON.stringify({ name, args }), "utf8").toString("base64url");
}

function decodeCodeModeTarget(code: string | undefined) {
  const marker = code
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(`// ${QA_CODE_MODE_TARGET_MARKER}`));
  if (!marker) {
    return null;
  }
  try {
    const encoded = marker.slice(`// ${QA_CODE_MODE_TARGET_MARKER}`.length).trim();
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!isRecord(parsed) || typeof parsed.name !== "string" || !isRecord(parsed.args)) {
      return null;
    }
    return { name: parsed.name, args: parsed.args };
  } catch {
    return null;
  }
}

export function resolveCodeModeExecSurface(
  body: Record<string, unknown>,
): MockOpenAiCodeModeExecSurface | null {
  const tools = [
    ...(Array.isArray(body.tools) ? body.tools : []),
    ...(Array.isArray(body.dynamicTools) ? body.dynamicTools : []),
  ];
  const execDefinition = findNamedToolDefinition(tools, "exec");
  if (!execDefinition || !hasToolDefinition(body, "wait")) {
    return null;
  }
  if (execDefinition.type === "custom") {
    return "native";
  }
  const schema = execDefinition.input_schema ?? execDefinition.parameters;
  if (!isRecord(schema)) {
    return null;
  }
  const properties = schema.properties;
  const required = schema.required;
  return properties !== null &&
    typeof properties === "object" &&
    !Array.isArray(properties) &&
    Object.hasOwn(properties, "code") &&
    Array.isArray(required) &&
    required.includes("code")
    ? "guest"
    : null;
}

function hasCodeModeExecSurface(body: Record<string, unknown>) {
  return resolveCodeModeExecSurface(body) !== null;
}

export function resolveCurrentToolDeclarationSurface(
  body: Record<string, unknown>,
  input: ResponsesInputItem[],
) {
  const additionalTools = input.flatMap((item) =>
    item.type === "additional_tools" && item.role === "developer" && Array.isArray(item.tools)
      ? item.tools
      : [],
  );
  return additionalTools.length === 0
    ? body
    : {
        ...body,
        tools: [...(Array.isArray(body.tools) ? body.tools : []), ...additionalTools],
      };
}

export function findToolCallByCallId(input: ResponsesInputItem[], callId: string) {
  return input.toReversed().find((item) => {
    const type = item.type;
    return (type === "function_call" || type === "custom_tool_call") && item.call_id === callId;
  });
}

function parseToolCallArguments(toolCall: ResponsesInputItem) {
  if (typeof toolCall.arguments !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(toolCall.arguments) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readGeneratedCodeModeExecSource(toolCall: ResponsesInputItem | undefined) {
  if (toolCall?.type === "custom_tool_call" && typeof toolCall.input === "string") {
    return toolCall.input;
  }
  const code = toolCall ? parseToolCallArguments(toolCall)?.code : undefined;
  return typeof code === "string" ? code : undefined;
}

function isGeneratedCodeModeExecCall(toolCall: ResponsesInputItem | undefined) {
  const source = toolCall?.name === "exec" ? readGeneratedCodeModeExecSource(toolCall) : undefined;
  return typeof source === "string" && decodeCodeModeTarget(source) !== null;
}

export function parseNativeCodeModeOutput(
  output: unknown,
): { status: "waiting"; cellId: string } | { status: "completed"; value: unknown } | null {
  if (!Array.isArray(output)) {
    return null;
  }
  const readText = (item: unknown) =>
    typeof item === "string"
      ? item
      : isRecord(item) && typeof item.text === "string"
        ? item.text
        : null;
  const statusText = readText(output[0]);
  if (!statusText) {
    return null;
  }
  const cellId = /^Script running with cell ID ([^\s\n]+)/u.exec(statusText)?.[1];
  if (cellId) {
    return { status: "waiting", cellId };
  }
  if (!statusText.startsWith("Script completed\n")) {
    return null;
  }
  for (const item of output.slice(1).toReversed()) {
    const text = readText(item);
    if (!text) {
      continue;
    }
    try {
      return { status: "completed", value: JSON.parse(text) as unknown };
    } catch {
      // Native Code Mode may emit non-JSON content before the final value.
    }
  }
  return null;
}

function isGeneratedCodeModeWaitCall(input: ResponsesInputItem[], toolCall: ResponsesInputItem) {
  if (toolCall.name !== "wait") {
    return false;
  }
  const args = parseToolCallArguments(toolCall);
  const waitId =
    typeof args?.cell_id === "string"
      ? args.cell_id
      : typeof args?.runId === "string"
        ? args.runId
        : undefined;
  if (!waitId) {
    return false;
  }
  return input.some((item) => {
    if (
      (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") ||
      typeof item.call_id !== "string"
    ) {
      return false;
    }
    const native = parseNativeCodeModeOutput(item.output);
    const parsed = native ?? parseToolOutputJson(stringifyScenarioToolOutput(item.output));
    return (
      parsed?.status === "waiting" &&
      (("cellId" in parsed && parsed.cellId === waitId) ||
        ("runId" in parsed && parsed.runId === waitId)) &&
      isGeneratedCodeModeExecCall(findToolCallByCallId(input, item.call_id))
    );
  });
}

export function readRestartCheckpointProgress(input: ResponsesInputItem[]) {
  const checkpoints = new Set<number>();
  for (const item of input) {
    if (item.name !== "exec") {
      continue;
    }
    const source = readGeneratedCodeModeExecSource(item);
    if (!source?.includes("qa_restart_wait")) {
      continue;
    }
    for (const match of source.matchAll(/\bCHECKPOINT-([1-3])\b/gu)) {
      checkpoints.add(Number(match[1]));
    }
  }
  const waitCount = input.filter((item) => isGeneratedCodeModeWaitCall(input, item)).length;
  return {
    checkpoints: [...checkpoints].toSorted((left, right) => left - right),
    waitCount,
  };
}

export function isCodeModeControlToolOutput(
  body: Record<string, unknown>,
  input: ResponsesInputItem[],
) {
  if (!hasCodeModeExecSurface(body)) {
    return false;
  }
  const toolOutputCallId = extractToolOutputCallId(input);
  if (!toolOutputCallId) {
    return false;
  }
  const toolCall = findToolCallByCallId(input, toolOutputCallId);
  return (
    isGeneratedCodeModeExecCall(toolCall) ||
    (toolCall ? isGeneratedCodeModeWaitCall(input, toolCall) : false)
  );
}

export function canCallScenarioTool(body: Record<string, unknown>, name: string) {
  // The catalog dispatcher owns target lookup and authorization. Its public
  // contract accepts an exact known name without a redundant search round trip.
  return (
    hasToolDefinition(body, name) ||
    hasCodeModeExecSurface(body) ||
    hasToolDefinition(body, "tool_call")
  );
}

export function readScenarioCompletedToolName(toolCall: ResponsesInputItem | undefined) {
  if (toolCall?.name === "tool_call") {
    const id = parseToolCallArguments(toolCall)?.id;
    return typeof id === "string" ? id : undefined;
  }
  if (toolCall?.name === "exec") {
    return decodeCodeModeTarget(readGeneratedCodeModeExecSource(toolCall))?.name;
  }
  return toolCall?.name;
}

export function unwrapScenarioCatalogOutput(
  input: ResponsesInputItem[],
  output = extractToolOutput(input),
  projection: "details" | "content" = "details",
) {
  const call = findToolCallByCallId(input, extractToolOutputCallId(input));
  if (call?.name !== "tool_call") {
    return output;
  }
  const envelope = parseToolOutputJson(output);
  const id = parseToolCallArguments(call)?.id;
  if (
    !isRecord(envelope?.tool) ||
    (envelope.tool.name !== id && envelope.tool.id !== id) ||
    !isRecord(envelope.result)
  ) {
    return output;
  }
  // Keep target failures and receipt fields at the same level as direct calls.
  // Do not unwrap unrelated JSON stdout or an unmatched catalog result.
  const result = envelope.result;
  if (projection === "details") {
    if (extractToolOutputStructuredError(input) === true) {
      return stringifyScenarioToolOutput({
        ...(isRecord(result.details) ? result.details : {}),
        status: "error",
      });
    }
    if (Object.hasOwn(result, "details")) {
      return stringifyScenarioToolOutput(result.details);
    }
  }
  return Array.isArray(result.content)
    ? result.content
        .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
    : output;
}

function readProgressCommandOutput(input: ResponsesInputItem[], command: string, isPoll = false) {
  const text = unwrapScenarioCatalogOutput(input, extractToolOutput(input), "content");
  // Provider wires carry content, not process details; JSON stdout remains data.
  const sessionId = !isPoll
    ? /(?:^|\n\n)Command still running \(session ([^,\s]+), pid (?:\d+|n\/a)\)\. Use process \(list\/poll\/log\/write\/send-keys\/submit\/paste\/kill\/clear\/remove\) for follow-up\.$/u.exec(
        text,
      )?.[1]
    : undefined;
  const running =
    Boolean(sessionId) ||
    (isPoll &&
      /\n\n(?:Process still running\.|No new output for [^;\n]+; this session may be waiting for input\. Use process write, send-keys, submit, or paste to provide input\.)$/u.test(
        text,
      ));
  // Final footers own lifecycle: Node exec joins with one newline; other owners append two.
  // Timeout guidance is one line, so earlier stdout cannot swallow a later real footer.
  const exitPattern = isPoll
    ? /(?:^|\n\n)Process exited with (code -?\d+|signal \S+|unknown exit code)\.(\n\nThe command was terminated,[^\n]*)?$/u
    : /^Node: [^\n]+\n/u.test(text)
      ? /(?:^|\n)\(Command exited with (code -?\d+)\)$/u
      : /(?:^|\n\n)\(Command exited with (code -?\d+)\)$/u;
  const exit = exitPattern.exec(text);
  // Bind the command inside the matcher so warning text cannot hide a later native notice.
  const commandPattern = escapeRegExp(command);
  const approval = new RegExp(
    String.raw`(?:^|\n\n)Approval required \(id (?<approvalSlug>[^,\n]+), full [^\n]+\)\.\nHost: (?:gateway|node)\n(?:Node: [^\n]+\n)?CWD: [^\n]+\nCommand:\n(?<fence>\x60{3,})sh\n${commandPattern}\n\k<fence>\nMode: foreground \(interactive approvals available\)\.\n(?:Background mode [^\n]+\n)?Reply with: \/approve \k<approvalSlug> (?<decisions>allow-once(?:\|allow-always)?\|deny)\n(?<unavailable>Allow Always is unavailable for this command\.\n)?If the short code is ambiguous, use the full id in \/approve\.$`,
    "u",
  ).exec(text)?.groups;
  const fence = approval?.fence;
  // Require the formatter's canonical fence and decision guidance so malformed quoted notices stay stdout.
  const pendingApproval =
    fence &&
    !command.includes(fence) &&
    (fence.length === 3 || command.includes(fence.slice(1))) &&
    Boolean(approval?.decisions?.includes("allow-always")) !== Boolean(approval?.unavailable);
  const unknownNotice = new RegExp(
    String.raw`(?:^|\n\n)Node command outcome is unknown for [^\n]+\.\nThe command may have executed\. Do not rerun it automatically\.\n\nCommand:\n${commandPattern}\n\nDetails: `,
    "u",
  ).test(text);
  let state: "running" | "completed" | "failed" | "unconfirmed";
  if (
    !isPoll &&
    (pendingApproval ||
      /(?:^|\n\n)Approval required\. I sent approval DMs to the approvers for this account\.$/u.test(
        text,
      ) ||
      /(?:^|\n\n)Exec approval is required, but no interactive approval client is currently available\.\n\nApprove it from the Web UI or terminal UI[^\n]* Print the Control UI URL with `openclaw dashboard --no-open`, open it in a browser, then use the approval inbox\.[^\n]* Then retry the command\. You can usually leave execApprovals\.approvers unset when owner config already identifies the approvers\.$/u.test(
        text,
      ) ||
      unknownNotice)
  ) {
    // Complete notices own lifecycle state; an unknown result's Details tail is only diagnostic text.
    state = "unconfirmed";
  } else if (extractToolOutputStructuredError(input) === true) {
    // A poll error without terminal evidence cannot establish that the command failed.
    state = running || (isPoll && !exit) ? "unconfirmed" : "failed";
  } else if (running) {
    state = "running";
  } else if (exit) {
    state = exit[2] !== undefined || exit[1] !== "code 0" ? "failed" : "completed";
  } else {
    // Foreground success can be empty; a poll needs an explicit terminal result.
    state = isPoll ? "unconfirmed" : "completed";
  }
  return { state, sessionId };
}

export function readProgressCommand(input: ResponsesInputItem[], command: string) {
  let current: ReturnType<typeof readProgressCommandOutput> | undefined;
  let sessionId: string | undefined;
  let pendingCall: ResponsesInputItem | undefined;
  // Walk the whole turn so a valid exec or poll cannot hide an earlier foreign call.
  for (const item of input) {
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const wireArgs = parseToolCallArguments(item);
      const name = item.name === "tool_call" ? readScenarioCompletedToolName(item) : item.name;
      const args = item.name === "tool_call" && isRecord(wireArgs?.args) ? wireArgs.args : wireArgs;
      if (
        pendingCall ||
        typeof item.call_id !== "string" ||
        item.call_id.length === 0 ||
        (current
          ? current.state !== "running" ||
            !sessionId ||
            name !== "process" ||
            args?.action !== "poll" ||
            args.sessionId !== sessionId
          : item.type !== "function_call" || name !== "exec" || args?.command !== command)
      ) {
        return { error: "BUG-TOOL-PROGRESS-CALL-MISMATCH" };
      }
      pendingCall = item;
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      if (!pendingCall || item.call_id !== pendingCall.call_id) {
        return { error: "BUG-TOOL-PROGRESS-CALL-MISMATCH" };
      }
      const isPoll = current !== undefined;
      current = readProgressCommandOutput([pendingCall, item], command, isPoll);
      if (!isPoll) {
        sessionId = current.sessionId;
      }
      pendingCall = undefined;
    }
  }
  if (!current) {
    return {
      error: pendingCall ? "BUG-TOOL-PROGRESS-RESULT-MISSING" : "BUG-TOOL-PROGRESS-CALL-MISMATCH",
    };
  }
  if (pendingCall || current.state === "unconfirmed") {
    return { error: "BUG-TOOL-DID-NOT-COMPLETE" };
  }
  if (current.state === "running") {
    return sessionId ? { sessionId } : { error: "BUG-TOOL-PROGRESS-SESSION-MISSING" };
  }
  return { failed: current.state === "failed" };
}

export function buildScenarioToolCallEvents(
  body: Record<string, unknown>,
  name: string,
  args: Record<string, unknown>,
) {
  // Direct declarations win. Otherwise use a declared dispatcher, never emit
  // an undeclared raw target to evade the effective catalog policy.
  if (
    !hasToolDefinition(body, name) &&
    !hasCodeModeExecSurface(body) &&
    hasToolDefinition(body, "tool_call")
  ) {
    return buildScenarioToolCallEvents(body, "tool_call", { id: name, args });
  }
  if (
    name === "exec" ||
    name === "wait" ||
    hasToolDefinition(body, name) ||
    !hasCodeModeExecSurface(body)
  ) {
    const declaration = [
      ...(Array.isArray(body.tools) ? body.tools : []),
      ...(Array.isArray(body.dynamicTools) ? body.dynamicTools : []),
    ].find((tool) => findNamedToolDefinition(tool, name));
    const definition = findNamedToolDefinition(declaration, name);
    // Function and custom calls both retain their declared namespace; Codex
    // dispatches the complete identity and rejects a flattened nested tool.
    const namespace =
      declaration &&
      typeof declaration === "object" &&
      declaration.type === "namespace" &&
      typeof declaration.name === "string"
        ? declaration.name
        : undefined;
    if (definition?.type === "custom" && typeof args.input === "string") {
      return buildCustomToolCallEventsWithInput(name, args.input, namespace);
    }
    const callArgs =
      name === "exec" && typeof args.code === "string"
        ? { title: "Run the QA fixture step", ...args }
        : args;
    return buildRawToolCallEventsWithArgs(name, callArgs, namespace);
  }
  const encodedTarget = encodeCodeModeTarget(name, args);
  if (resolveCodeModeExecSurface(body) === "native") {
    return buildCustomToolCallEventsWithInput(
      "exec",
      [
        `// ${QA_CODE_MODE_TARGET_MARKER}${encodedTarget}`,
        `const targetName = ${JSON.stringify(name)};`,
        `const targetArgs = ${JSON.stringify(args)};`,
        "const target = ALL_TOOLS.find((entry) => entry.name === targetName);",
        "if (!target) throw new Error(`QA mock target tool unavailable: ${targetName}`);",
        "let value = await tools[target.name](targetArgs);",
        'if (targetName === "read" && value?.kind === "text" && typeof value.content === "string") {',
        "  value = { ...value, content: value.content.slice(0, 2048) };",
        "}",
        "text(JSON.stringify(value));",
      ].join("\n"),
    );
  }
  return buildRawToolCallEventsWithArgs("exec", {
    title: "Run the QA fixture step",
    code: [
      `// ${QA_CODE_MODE_TARGET_MARKER}${encodedTarget}`,
      `const targetName = ${JSON.stringify(name)};`,
      `const targetArgs = ${JSON.stringify(args)};`,
      "const target = (await catalog.search(targetName)).find((entry) => entry.toolName === targetName);",
      "if (!target) throw new Error(`QA mock target tool unavailable: ${targetName}`);",
      "const value = await target(targetArgs);",
      'if (targetName === "read" && value?.kind === "text" && typeof value.content === "string") {',
      "  return { ...value, content: value.content.slice(0, 2048) };",
      "}",
      "return value;",
    ].join("\n"),
  });
}

export function extractScenarioPlannedTool(events: StreamEvent[]) {
  const wireName = extractPlannedToolName(events);
  const wireArgs = extractPlannedToolArgs(events);
  const source =
    typeof wireArgs?.input === "string"
      ? wireArgs.input
      : typeof wireArgs?.code === "string"
        ? wireArgs.code
        : undefined;
  if (wireName === "tool_call" && typeof wireArgs?.id === "string" && isRecord(wireArgs.args)) {
    return { name: wireArgs.id, args: wireArgs.args, wireName };
  }
  if (wireName !== "exec" || !source) {
    return { name: wireName, args: wireArgs, wireName };
  }
  const target = decodeCodeModeTarget(source);
  return target
    ? { name: target.name, args: target.args, wireName }
    : { name: wireName, args: wireArgs, wireName };
}
