import {
  asFiniteNumber,
  isRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

function isCorrelationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}

function readHistoryActivity(
  message: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (
    message.details !== undefined ||
    !Array.isArray(message.content) ||
    message.content.length !== 2
  ) {
    return undefined;
  }
  const [call, result] = message.content;
  const metadata = message["__openclaw"];
  if (
    !isRecord(call) ||
    !isRecord(result) ||
    call.type !== "toolCall" ||
    result.type !== "toolResult" ||
    result.role !== "toolResult" ||
    !isCorrelationId(message.runId) ||
    !isRecord(metadata) ||
    metadata.runId !== message.runId ||
    call.runId !== message.runId ||
    result.runId !== call.runId ||
    call.id !== result.toolCallId ||
    call.name !== result.toolName ||
    call.parentToolCallId !== result.parentToolCallId ||
    call.timestamp !== result.startedAt ||
    !Object.hasOwn(call, "arguments")
  ) {
    return undefined;
  }
  // Public history strips private details after publishing these correlated blocks.
  return {
    ...result,
    input: call.arguments,
    result: { content: result.content, details: result.details },
  };
}

/** Read a terminal receipt or its canonical public-history projection. */
export function readQaNestedToolActivity(message: Record<string, unknown>) {
  if (
    message.role !== "custom" ||
    message.customType !== "openclaw.nested-tool.v1" ||
    message.display !== true ||
    message.excludeFromContext !== true ||
    (message.content !== "" && !Array.isArray(message.content)) ||
    typeof message.timestamp !== "number" ||
    !Number.isFinite(message.timestamp)
  ) {
    return undefined;
  }
  const details =
    message.content === ""
      ? isRecord(message.details)
        ? message.details
        : undefined
      : readHistoryActivity(message);
  if (
    !details ||
    !isCorrelationId(details.runId) ||
    !isCorrelationId(details.scopeId) ||
    (details.afterEntryId !== null && !isCorrelationId(details.afterEntryId)) ||
    typeof details.startOrder !== "number" ||
    !Number.isSafeInteger(details.startOrder) ||
    details.startOrder < 0 ||
    (details.parentToolCallId !== undefined && !isCorrelationId(details.parentToolCallId)) ||
    !isCorrelationId(details.toolCallId) ||
    typeof details.toolName !== "string" ||
    details.toolName.length === 0 ||
    details.toolName.length > 256 ||
    typeof details.isError !== "boolean" ||
    typeof details.startedAt !== "number" ||
    !Number.isFinite(details.startedAt) ||
    typeof details.timestamp !== "number" ||
    !Number.isFinite(details.timestamp) ||
    !Object.hasOwn(details, "input") ||
    !isRecord(details.result) ||
    !Array.isArray(details.result.content)
  ) {
    return undefined;
  }
  return {
    runId: details.runId,
    scopeId: details.scopeId,
    afterEntryId: details.afterEntryId,
    startOrder: details.startOrder,
    parentToolCallId: details.parentToolCallId,
    toolCallId: details.toolCallId,
    toolName: details.toolName,
    isError: details.isError,
    input: details.input,
    timestamp: details.timestamp,
    startedAt: details.startedAt,
    result: details.result,
  };
}

/** QA-only call/result view; never writes synthetic turns into the transcript. */
export function projectQaToolMessages(messages: readonly unknown[]): Record<string, unknown>[] {
  return messages.flatMap((message) => {
    if (!isRecord(message)) {
      return [];
    }
    if (message.role !== "custom") {
      return [message];
    }
    const nested = readQaNestedToolActivity(message);
    if (!nested) {
      // Custom display blocks alone are not correlated execution evidence.
      return [];
    }
    const { input, result, ...activity } = nested;
    return [
      {
        role: "assistant",
        content: [
          {
            ...activity,
            type: "toolCall",
            id: activity.toolCallId,
            name: activity.toolName,
            arguments: input,
            timestamp: activity.startedAt,
          },
        ],
      },
      { ...result, ...activity, role: "toolResult" },
    ];
  });
}

type QaToolActivity = {
  toolCallId?: string;
  toolName: string;
  input: unknown;
  kind: "tool" | "code-mode-control";
  callIndex: number;
  /** Last transcript entry present when this operation was dispatched. */
  startAfterIndex?: number;
  resultIndex?: number;
  startedAt?: number;
  timestamp?: number;
  runId?: string;
  scopeId?: string;
  startOrder?: number;
  parentToolCallId?: string;
  result?: Record<string, unknown>;
  isError?: boolean;
  completed: boolean;
  successful: boolean;
};

function activityInput(input: unknown) {
  let value = isRecord(input) && typeof input.arguments === "string" ? input.arguments : input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return isRecord(value) ? value : undefined;
}

function nativeCodeModeCellId(result: Record<string, unknown>) {
  const block = Array.isArray(result.content) ? result.content[0] : undefined;
  const content =
    typeof result.content === "string"
      ? result.content
      : isRecord(block) && block.type === "text"
        ? block.text
        : undefined;
  if (typeof content !== "string") {
    return undefined;
  }
  let text = content;
  if (text.startsWith("[")) {
    // The Codex transcript adapter preserves response arrays as JSON text.
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      return undefined;
    }
    const header = Array.isArray(output) ? output[0] : undefined;
    const headerText = isRecord(header) && header.type === "input_text" ? header.text : undefined;
    if (typeof headerText !== "string") {
      return undefined;
    }
    text = headerText;
  }
  // Runtime fixture adapters trim the newline after an empty Output section.
  return /^Script running with cell ID (\S+)\r?\nWall time \d+(?:\.\d+)? seconds(?: \(code-mode \d+(?:\.\d+)? seconds; overhead -?\d+(?:\.\d+)? seconds\))?\r?\nOutput:(?:\r?\n|$)/u.exec(
    text,
  )?.[1];
}

/** Correlated logical operations; dispatcher rows remain visible as control activity. */
export function projectQaToolActivity(messages: readonly unknown[]): QaToolActivity[] {
  const activity: QaToolActivity[] = [];
  const entryIndexes = new Map<string, number>();
  const calls = new Map<string, QaToolActivity>();
  const conflictingIds = new Set<string>();
  const parentIds = new Set<string>();
  const codeModeRunIds = new Map<string, number>();
  const nativeCellIds = new Map<string, number>();

  const addCall = (call: QaToolActivity) => {
    const prior = call.toolCallId ? calls.get(call.toolCallId) : undefined;
    if (prior && call.toolCallId) {
      if (
        prior.toolName !== call.toolName ||
        JSON.stringify(prior.input) !== JSON.stringify(call.input)
      ) {
        conflictingIds.add(call.toolCallId);
      }
      return prior;
    }
    activity.push(call);
    if (call.toolCallId) {
      calls.set(call.toolCallId, call);
    }
    return call;
  };
  const settle = (result: Record<string, unknown>, index: number) => {
    const id = normalizeOptionalString(result.toolCallId);
    const call = id ? calls.get(id) : undefined;
    if (!call || !id) {
      return;
    }
    const name = normalizeOptionalString(result.toolName);
    if (name && name !== call.toolName) {
      conflictingIds.add(id);
      return;
    }
    const timestamp = asFiniteNumber(result.timestamp);
    const isError = typeof result.isError === "boolean" ? result.isError : undefined;
    const details = isRecord(result.details) ? result.details : undefined;
    const shell =
      ["exec", "exec_command", "gateway_exec", "sandbox_exec", "node_exec"].includes(
        call.toolName,
      ) ||
      (["process", "gateway_process", "sandbox_process"].includes(call.toolName) &&
        activityInput(call.input)?.action === "poll");
    const pending =
      shell && ["running", "waiting", "approval-pending"].includes(String(details?.status));
    const completed = !pending;
    const exitCode = details?.exitCode ?? details?.exit_code;
    const hasExitCode =
      details && (Object.hasOwn(details, "exitCode") || Object.hasOwn(details, "exit_code"));
    const successful =
      completed &&
      isError === false &&
      (!shell ||
        ((!hasExitCode || exitCode === 0) &&
          !["failed", "error", "unavailable", "approval-unavailable"].includes(
            String(details?.status),
          ))) &&
      (call.startedAt === undefined || timestamp === undefined || timestamp >= call.startedAt);
    if (call.completed) {
      // Identical receipt replays settle once; contradictory outcomes cannot prove success.
      if (completed && (call.successful !== successful || call.isError !== isError)) {
        conflictingIds.add(id);
      }
      return;
    }
    Object.assign(call, { result, resultIndex: index, timestamp, isError, completed, successful });
  };

  messages.forEach((event, index) => {
    const entry =
      isRecord(event) && event.type === "message" && isRecord(event.message) ? event : undefined;
    const message = entry?.message ?? event;
    if (!isRecord(message)) {
      return;
    }
    if (entry && isCorrelationId(entry.id)) {
      entryIndexes.set(entry.id, index);
    }
    const nested = readQaNestedToolActivity(message);
    if (nested) {
      const afterIndex =
        typeof nested.afterEntryId === "string" ? entryIndexes.get(nested.afterEntryId) : undefined;
      if (nested.parentToolCallId) {
        parentIds.add(nested.parentToolCallId);
      }
      addCall({
        toolCallId: nested.toolCallId,
        toolName: nested.toolName,
        input: nested.input,
        kind: "tool",
        callIndex: index,
        startAfterIndex: afterIndex !== undefined && afterIndex < index ? afterIndex : undefined,
        startedAt: nested.startedAt,
        runId: nested.runId,
        scopeId: nested.scopeId,
        startOrder: nested.startOrder,
        parentToolCallId: nested.parentToolCallId,
        completed: false,
        successful: false,
      });
      settle(
        {
          ...nested.result,
          toolCallId: nested.toolCallId,
          toolName: nested.toolName,
          timestamp: nested.timestamp,
          isError: nested.isError,
        },
        index,
      );
      return;
    }
    if (message.role === "toolResult") {
      settle(message, index);
      return;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return;
    }
    for (const block of message.content) {
      if (!isRecord(block) || !["toolCall", "toolUse", "tool_use"].includes(String(block.type))) {
        continue;
      }
      const toolName = normalizeOptionalString(block.name);
      if (!toolName) {
        continue;
      }
      const input = block.arguments ?? block.input;
      const controlInput = activityInput(input);
      addCall({
        toolCallId: normalizeOptionalString(block.id),
        toolName,
        input,
        kind:
          toolName === "exec" &&
          (block.toolKind === "code_mode_exec" ||
            typeof controlInput?.code === "string" ||
            typeof controlInput?.input === "string")
            ? "code-mode-control"
            : "tool",
        callIndex: index,
        startAfterIndex: index - 1,
        startedAt: asFiniteNumber(block.timestamp) ?? asFiniteNumber(message.timestamp),
        completed: false,
        successful: false,
      });
    }
  });
  for (const call of activity) {
    if (call.toolCallId && conflictingIds.has(call.toolCallId)) {
      call.completed = false;
      call.successful = false;
    }
    if (call.toolName === "exec" && call.toolCallId && parentIds.has(call.toolCallId)) {
      call.kind = "code-mode-control";
    }
    const details = call.result && isRecord(call.result.details) ? call.result.details : undefined;
    if (
      call.kind !== "code-mode-control" ||
      call.isError !== false ||
      call.resultIndex === undefined ||
      (call.toolCallId && conflictingIds.has(call.toolCallId))
    ) {
      continue;
    }
    if (details?.status === "waiting" && typeof details.runId === "string") {
      codeModeRunIds.set(
        details.runId,
        Math.min(codeModeRunIds.get(details.runId) ?? Infinity, call.resultIndex),
      );
    }
    if (typeof activityInput(call.input)?.input === "string" && call.result) {
      const cellId = nativeCodeModeCellId(call.result);
      if (cellId) {
        nativeCellIds.set(
          cellId,
          Math.min(nativeCellIds.get(cellId) ?? Infinity, call.resultIndex),
        );
      }
    }
  }
  for (const call of activity) {
    const input = activityInput(call.input);
    const sourceIndex =
      typeof input?.runId === "string"
        ? codeModeRunIds.get(input.runId)
        : typeof input?.cell_id === "string"
          ? nativeCellIds.get(input.cell_id)
          : undefined;
    if (call.toolName === "wait" && sourceIndex !== undefined && call.callIndex > sourceIndex) {
      call.kind = "code-mode-control";
    }
  }
  const ordered = activity.toSorted((left, right) => {
    const leftTime = left.startedAt ?? Infinity;
    const rightTime = right.startedAt ?? Infinity;
    return leftTime === rightTime ? left.callIndex - right.callIndex : leftTime - rightTime;
  });
  const scopeKey = (call: QaToolActivity) =>
    call.runId && call.scopeId && call.startedAt !== undefined && call.startOrder !== undefined
      ? JSON.stringify([call.runId, call.scopeId, call.startedAt])
      : undefined;
  const scopes = new Map<string, Array<{ call: QaToolActivity; order: number }>>();
  for (const call of ordered) {
    const key = scopeKey(call);
    if (key && call.startOrder !== undefined) {
      const group = scopes.get(key) ?? [];
      group.push({ call, order: call.startOrder });
      scopes.set(key, group);
    }
  }
  for (const group of scopes.values()) {
    group.sort(
      (left, right) => right.order - left.order || right.call.callIndex - left.call.callIndex,
    );
  }
  // Equal-millisecond nested receipts may arrive in completion order. Reorder only
  // their own scope's slots, preserving timestamp chronology and other scopes.
  return ordered.map((call) => {
    const key = scopeKey(call);
    return (key ? scopes.get(key)?.pop()?.call : undefined) ?? call;
  });
}
