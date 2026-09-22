import { isDeepStrictEqual } from "node:util";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  getPluginToolMeta,
  getChannelAgentToolMeta,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { asOptionalRecord as asRecord, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  markSynchronousCoreFileResult,
  type CodexDynamicToolRuntimeResponse,
  type SynchronousCoreFileReceipt,
} from "./dynamic-tool-response-state.js";

export function isReplaySafeToolInstance(tool: AnyAgentTool): boolean {
  const plugin = getPluginToolMeta(tool);
  if (plugin) {
    return plugin.replaySafe === true;
  }
  // SAFETY: the channel metadata reader only uses this object as a WeakMap identity key; it invokes no ChannelAgentTool operations.
  return getChannelAgentToolMeta(tool as never) === undefined;
}

/** Snapshot the permitted lossless projection before presentation code sees the result.
 * Only strings leave this scope; raw tool details (which may contain secrets) do not.
 */
export function captureSettledCoreFileResult(
  name: string,
  tool: AnyAgentTool,
  args: unknown,
  raw: AgentToolResult<unknown>,
): SynchronousCoreFileReceipt | undefined {
  try {
    if (
      !["read", "write", "edit", "apply_patch"].includes(name) ||
      getPluginToolMeta(tool) !== undefined ||
      !isReplaySafeToolInstance(tool) ||
      isAsyncStartedToolResult(raw) ||
      !Array.isArray(raw.content) ||
      !raw.content.every((part) => part.type === "text" && typeof part.text === "string")
    ) {
      return undefined;
    }
    const argumentsJson = JSON.stringify(args);
    if (!isDeepStrictEqual(JSON.parse(argumentsJson), args)) {
      return undefined;
    }
    const contentJson = JSON.stringify(
      raw.content.map((part) => ({ type: "inputText", text: asRecord(part)?.text })),
    );
    return Object.freeze({ tool: name, argumentsJson, contentJson });
  } catch {
    return undefined;
  }
}

/** The final bridge response must still be the captured execution result, losslessly. */
export function markSettledCoreFileResponse(
  receipt: SynchronousCoreFileReceipt | undefined,
  response: CodexDynamicToolRuntimeResponse,
): void {
  if (!receipt || !response.success || response.asyncStarted) {
    return;
  }
  try {
    if (
      isDeepStrictEqual(JSON.parse(receipt.argumentsJson), response.executedArguments) &&
      isDeepStrictEqual(JSON.parse(receipt.contentJson), response.contentItems)
    ) {
      markSynchronousCoreFileResult(response, receipt);
    }
  } catch {
    // Optional continuation must not change the ordinary sanitized tool response.
  }
}

export function isAsyncStartedToolResult(result: AgentToolResult<unknown>): boolean {
  const details = result.details;
  return isRecord(details) && details.async === true && details.status === "started";
}

export function isToolResultYield(result: AgentToolResult<unknown>): boolean {
  const details = result.details;
  if (!isRecord(details) || typeof details.status !== "string") {
    return false;
  }
  return details.status.trim().toLowerCase() === "yielded";
}
