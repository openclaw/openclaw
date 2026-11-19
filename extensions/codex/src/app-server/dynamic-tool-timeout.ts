import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  addSafeTimeoutDelayGraceMs,
  addTimerTimeoutGraceMs,
  asFiniteNumberInRange,
  floorPositiveFiniteNumber as readPositiveFiniteTimeoutMs,
  MAX_TIMER_TIMEOUT_MS,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeQuestionTimeoutSeconds } from "openclaw/plugin-sdk/time-runtime";
import type { CodexDynamicToolBridge } from "./dynamic-tools.js";
import { isJsonObject, type CodexDynamicToolCallParams, type JsonValue } from "./protocol.js";

const CODEX_DYNAMIC_TOOL_TIMEOUT_MS = 90_000;
const CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS = 600_000;
// timeoutSeconds is an inner tool budget. Keep enough outer-watchdog headroom
// for bounded setup RPCs and the tool's structured timeout result to complete.
const CODEX_DYNAMIC_TOOL_TIMEOUT_SECONDS_GRACE_MS = 30_000;
const CODEX_DYNAMIC_IMAGE_GENERATION_TOOL_TIMEOUT_MS = 120_000;
const CODEX_DYNAMIC_COMPUTER_GATEWAY_TIMEOUT_MS = 30_000;
const CODEX_DYNAMIC_COMPUTER_COMPLETION_GRACE_MS = 30_000;
const CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS = 60_000;
const CODEX_DYNAMIC_MESSAGE_TOOL_TIMEOUT_MS = 600_000;
/** Outer default for collector waits: full swarm budget plus completion grace. */
const CODEX_DYNAMIC_AGENTS_WAIT_TOOL_TIMEOUT_MS =
  CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS + CODEX_DYNAMIC_TOOL_TIMEOUT_SECONDS_GRACE_MS;

export function resolveDynamicToolCallTimeoutMs(params: {
  call: CodexDynamicToolCallParams;
  config: EmbeddedRunAttemptParams["config"];
  toolBridge?: Pick<CodexDynamicToolBridge, "availableTools">;
  parentTimeoutMs?: number;
}): number | null {
  if (params.call.tool === "autoreview" && params.parentTimeoutMs !== undefined) {
    // The canonical helper plans passes after preparation. The admitted parent
    // owns their total lifetime; its original deadline and abort signal stay live.
    return params.parentTimeoutMs >= MAX_TIMER_TIMEOUT_MS
      ? null
      : addSafeTimeoutDelayGraceMs(
          params.parentTimeoutMs,
          CODEX_DYNAMIC_TOOL_TIMEOUT_SECONDS_GRACE_MS,
        );
  }
  const args = isJsonObject(params.call.arguments) ? params.call.arguments : undefined;
  if (params.call.tool === "node_exec") {
    const executionTimeoutMs = params.toolBridge?.availableTools
      .find((tool) => tool.name === params.call.tool)
      ?.getExecutionTimeoutMs?.(params.call.arguments);
    if (executionTimeoutMs !== undefined) {
      // Foreground node execution owns its command and transport budgets.
      return addSafeTimeoutDelayGraceMs(
        executionTimeoutMs,
        CODEX_DYNAMIC_TOOL_TIMEOUT_SECONDS_GRACE_MS,
      );
    }
  }
  if (
    params.call.tool === "openclaw" ||
    params.call.tool === "ask_user" ||
    (params.call.tool === "secrets" && args?.action === "request")
  ) {
    try {
      // Human entry owns a validated wait longer than ordinary tool execution.
      // OpenClaw delegation uses that default for its ten-minute approval plus
      // staging/application; it has no model-authored timeout override.
      const timeoutSeconds = params.call.tool === "openclaw" ? undefined : args?.timeoutSeconds;
      return (
        normalizeQuestionTimeoutSeconds(timeoutSeconds) * 1_000 +
        CODEX_DYNAMIC_TOOL_TIMEOUT_SECONDS_GRACE_MS
      );
    } catch {
      // Invalid input still reaches the tool's validation under the ordinary watchdog.
      return CODEX_DYNAMIC_TOOL_TIMEOUT_MS;
    }
  }
  if (params.call.tool === "computer") {
    return clampDynamicToolTimeoutMs(readComputerToolTimeoutMs(params.call.arguments));
  }
  // The message tool's `timeoutMs` is a Gateway transport budget. Its outer
  // watchdog must also cover bounded same-key reconciliation after that timer.
  if (params.call.tool === "message") {
    return CODEX_DYNAMIC_MESSAGE_TOOL_TIMEOUT_MS;
  }
  // Collector waits need the full swarm budget plus grace for their structured timeout.
  const isCollectorWait = params.call.tool === "agents_wait";
  return clampDynamicToolTimeoutMs(
    readDynamicToolCallTimeoutMs(params.call.arguments) ??
      readConfiguredDynamicToolTimeoutMs(params.call.tool, params.config) ??
      (isCollectorWait ? CODEX_DYNAMIC_AGENTS_WAIT_TOOL_TIMEOUT_MS : CODEX_DYNAMIC_TOOL_TIMEOUT_MS),
    isCollectorWait ? CODEX_DYNAMIC_AGENTS_WAIT_TOOL_TIMEOUT_MS : CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS,
  );
}

/** Transport guard stays outside the handler's bounded tool wait and completion grace. */
export function resolveDynamicToolServerRequestTimeoutMs(
  call?: CodexDynamicToolCallParams,
): number {
  return (
    Math.max(
      CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS + CODEX_DYNAMIC_TOOL_TIMEOUT_SECONDS_GRACE_MS,
      call ? (resolveDynamicToolCallTimeoutMs({ call, config: undefined }) ?? 0) : 0,
    ) + CODEX_DYNAMIC_TOOL_TIMEOUT_SECONDS_GRACE_MS
  );
}

function readComputerToolTimeoutMs(value: JsonValue | undefined): number {
  const args = isJsonObject(value) ? value : undefined;
  const action = typeof args?.action === "string" ? args.action : undefined;
  const gatewayTimeoutMs =
    readPositiveFiniteTimeoutMs(args?.timeoutMs) ?? CODEX_DYNAMIC_COMPUTER_GATEWAY_TIMEOUT_MS;
  // Node discovery can make two calls when it falls back from node.list to the
  // legacy pairing list. Screenshot/wait then capture once; input also acts.
  const gatewayCallCount = action === "screenshot" || action === "wait" ? 3 : 4;
  const durationMs =
    action === "wait" || action === "hold_key"
      ? Math.max(0, Number(args?.duration) || 0) * 1000
      : 0;
  // `timeoutMs` is a per-Gateway-call transport budget, not the whole dynamic
  // tool deadline. Computer use can resolve a node, perform/wait, then capture.
  return (
    durationMs + gatewayCallCount * gatewayTimeoutMs + CODEX_DYNAMIC_COMPUTER_COMPLETION_GRACE_MS
  );
}

function readDynamicToolCallTimeoutMs(value: JsonValue | undefined): number | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const timeoutMs = readPositiveFiniteTimeoutMs(value.timeoutMs);
  if (timeoutMs !== undefined) {
    return timeoutMs;
  }
  const timeoutSecondsMs = readDynamicToolTimeoutSecondsAsMs(value.timeoutSeconds);
  return timeoutSecondsMs === undefined
    ? undefined
    : addTimerTimeoutGraceMs(timeoutSecondsMs, CODEX_DYNAMIC_TOOL_TIMEOUT_SECONDS_GRACE_MS);
}

function readConfiguredDynamicToolTimeoutMs(
  toolName: string,
  config: EmbeddedRunAttemptParams["config"],
): number | undefined {
  if (toolName === "image_generate") {
    const imageModel = config?.agents?.defaults?.mediaModels?.image;
    if (!imageModel || typeof imageModel !== "object") {
      return CODEX_DYNAMIC_IMAGE_GENERATION_TOOL_TIMEOUT_MS;
    }
    return (
      readPositiveFiniteTimeoutMs(imageModel.timeoutMs) ??
      CODEX_DYNAMIC_IMAGE_GENERATION_TOOL_TIMEOUT_MS
    );
  }

  if (toolName === "view_image") {
    const candidates = (config?.tools?.media?.models ?? []).filter(
      (entry) => !entry.capabilities || entry.capabilities.includes("image"),
    );
    const capabilityTimeoutMs = readTimeoutSecondsAsMs(config?.tools?.media?.image?.timeoutSeconds);
    return Math.max(
      capabilityTimeoutMs ?? CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS,
      ...candidates.map(
        (entry) =>
          readTimeoutSecondsAsMs(entry.timeoutSeconds) ??
          capabilityTimeoutMs ??
          CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS,
      ),
    );
  }

  return undefined;
}

function readTimeoutSecondsAsMs(value: unknown): number | undefined {
  const seconds = readPositiveFiniteTimeoutMs(value);
  return seconds === undefined ? undefined : seconds * 1000;
}

function readDynamicToolTimeoutSecondsAsMs(value: unknown): number | undefined {
  // Model-facing timeoutSeconds schemas use integers. Reject malformed
  // fractions instead of silently shortening the caller's budget.
  const seconds = asFiniteNumberInRange(value, { min: 1 });
  return seconds !== undefined && Number.isInteger(seconds) ? seconds * 1000 : undefined;
}

function clampDynamicToolTimeoutMs(
  timeoutMs: number,
  maximum = CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS,
): number {
  return Math.max(1, Math.min(maximum, Math.floor(timeoutMs)));
}
