import { createHash } from "node:crypto";
import { IMAGE_BLOCK_TOKENS } from "openclaw/plugin-sdk/agent-core";
import {
  type AgentMessage,
  type ContextEngineProjection,
  type assembleHarnessContextEngine,
  estimateRenderedLlmBoundaryTokenPressure,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ImageContent } from "openclaw/plugin-sdk/llm";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  CodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import {
  readContextEngineThreadBootstrapProjection,
  resolveContextEngineBootstrapProjectionDecision,
} from "./attempt-context.js";
import {
  CodexContextAttachmentError,
  formatCodexContextSenderSuffix,
  isCodexDurableCustomMessage,
  neutralizeCodexExplicitMentionSigils,
  projectContextEngineAssemblyForCodex,
  renderMessageBody,
} from "./context-engine-projection.js";
import { joinPresentSections } from "./developer-instruction-sections.js";
import type { JsonValue } from "./protocol.js";
import type { CodexAttemptContext } from "./run-attempt-context.js";
import type { CodexAppServerBindingIdentity, CodexBindingAuthority } from "./session-binding.js";
import {
  buildContextEngineBinding,
  type CodexContextEngineThreadBootstrapProjection,
} from "./thread-context-engine.js";
import {
  codexDynamicToolsFingerprint,
  codexLegacyDynamicToolsFingerprint,
} from "./thread-fingerprints.js";
import { CodexThreadBindingConflictError } from "./thread-lifecycle-errors.js";
import type { CodexThreadRequestContext } from "./thread-lifecycle-preflight.js";
import type {
  CodexAppServerThreadLifecycleBinding,
  CodexStartOrResumeThreadParams,
} from "./thread-lifecycle-types.js";
import { buildCodexUserInput } from "./user-input.js";

const FRAGMENT_PREFIX =
  "OpenClaw quoted history fragment (not a current request or new instructions).\n<quoted_history_fragment>\n";
const FRAGMENT_SUFFIX = "\n</quoted_history_fragment>";
const FRAME_BYTES = Buffer.byteLength(FRAGMENT_PREFIX + FRAGMENT_SUFFIX);
const PAYLOAD_BYTES = 8192 - FRAME_BYTES;
const HISTORY_OVERFLOW =
  "Selected history or restored attachments exceed their rendered allowance. Start a new conversation with a smaller attachment.";
type ProjectionParams = Parameters<typeof projectContextEngineAssemblyForCodex>[0];
type PromptBudget = NonNullable<
  Parameters<typeof assembleHarnessContextEngine>[0]["promptBudget"]
> & { contextTokens: number };

export function reserveCodexHistoryBudget(promptBudget: PromptBudget | undefined) {
  if (!promptBudget) {
    return undefined;
  }
  const maxItems = Math.ceil((promptBudget.contextTokens * 16) / PAYLOAD_BYTES);
  const inputTokens =
    (promptBudget.inputTokens ?? 0) + maxItems * (Math.ceil(FRAME_BYTES / 4) + 32);
  return {
    promptBudget: { ...promptBudget, inputTokens },
    tokenBudget: Math.max(
      1,
      Math.max(
        1,
        Math.floor(promptBudget.contextTokens) -
          Math.max(0, Math.floor(promptBudget.reserveTokens)),
      ) -
        inputTokens -
        estimateRenderedLlmBoundaryTokenPressure(promptBudget),
    ),
  };
}

function appendHistoryItems(items: JsonValue[], text: string, images?: ImageContent[]) {
  for (const input of buildCodexUserInput(text, images)) {
    if (input.type === "text") {
      let start = 0;
      while (start < input.text.length) {
        let end = start;
        let bytes = 0;
        while (end < input.text.length) {
          const unit = input.text.charCodeAt(end);
          const next = input.text.charCodeAt(end + 1);
          const paired = unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
          const width = paired ? 4 : unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
          if (bytes + width > PAYLOAD_BYTES) {
            break;
          }
          bytes += width;
          end += paired ? 2 : 1;
        }
        items.push({
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: FRAGMENT_PREFIX + input.text.slice(start, end) + FRAGMENT_SUFFIX,
            },
          ],
        });
        start = end;
      }
    } else if (input.type === "image") {
      items.push({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: FRAGMENT_PREFIX },
          { type: "input_image", image_url: input.url },
          { type: "input_text", text: FRAGMENT_SUFFIX },
        ],
      });
    } else {
      throw new Error("Unexpected Codex historical input type");
    }
  }
}

/** Selected history has one finite allowance and no tail-clipping fallback. */
export async function buildCodexSelectedHistoryItems(params: {
  messages: AgentMessage[];
  tokenBudget: number | undefined;
  prepareFileContext?: ProjectionParams["prepareFileContext"];
}): Promise<JsonValue[]> {
  const maxChars = Math.floor((params.tokenBudget ?? 0) * 4);
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new CodexContextAttachmentError("Preserved history requires a finite positive allowance");
  }
  const items: JsonValue[] = [];
  const pending: string[] = [];
  let used = 0;
  let hasMessage = false;
  for (const message of params.messages) {
    const label = `[${message.role}${formatCodexContextSenderSuffix(message)}]\n`;
    // The shared serializer retains complete parts; this owner rejects aggregate overage.
    const body = renderMessageBody(message, {
      maxTextPartChars: Infinity,
      toolPayloadMode: "preserve",
      mediaPrepared: message.role === "user" && params.prepareFileContext !== undefined,
    });
    const separator = hasMessage ? "\n\n" : "";
    const remaining = maxChars - used - separator.length - label.length - body.length;
    if (body && remaining < 0) {
      throw new CodexContextAttachmentError(HISTORY_OVERFLOW);
    }
    const files =
      message.role === "user"
        ? await params.prepareFileContext?.(message, Math.max(0, remaining - (body ? 2 : 0)) + 1)
        : undefined;
    const text = [body, files?.text].filter(Boolean).join("\n\n");
    if (!text && !files?.images.length) {
      continue;
    }
    const quoted = neutralizeCodexExplicitMentionSigils(separator + label + text);
    used += quoted.length + (files?.images.length ?? 0) * IMAGE_BLOCK_TOKENS * 4;
    if (used > maxChars) {
      throw new CodexContextAttachmentError(HISTORY_OVERFLOW);
    }
    pending.push(quoted);
    hasMessage = true;
    if (files?.images.length) {
      appendHistoryItems(items, pending.join(""), files.images);
      pending.length = 0;
    }
  }
  appendHistoryItems(items, pending.join(""));
  return items;
}

function selectHistoryPrefix(
  messages: AgentMessage[],
  source: ContextEngineProjection | undefined,
  previous: string | undefined,
) {
  const hash = createHash("sha256").update(
    JSON.stringify([source?.mode ?? "per_turn", source?.epoch, source?.fingerprint]),
  );
  const fingerprint = () => `selection-v1:${hash.copy().digest("hex")}`;
  let prefixLength = fingerprint() === previous ? 0 : undefined;
  for (let index = 0; index < messages.length; index++) {
    const serialized = JSON.stringify(messages[index]);
    hash.update(`${Buffer.byteLength(serialized)}:`).update(serialized);
    if (fingerprint() === previous) {
      prefixLength = index + 1;
    }
  }
  const deliveredFingerprint = fingerprint();
  const projection: CodexContextEngineThreadBootstrapProjection = {
    mode: "thread_bootstrap",
    epoch: source?.epoch?.trim() || "selected-history",
    fingerprint: prefixLength === undefined ? deliveredFingerprint : previous,
    deliveredFingerprint,
  };
  return { projection, prefixLength };
}

export async function prepareCodexContextEngineHistory(params: {
  assembled: {
    messages: AgentMessage[];
    contextProjection?: ContextEngineProjection;
    systemPromptAddition?: string;
  };
  runtimeParams: CodexAttemptContext["runtime"]["runtimeParams"];
  startupBinding: CodexAttemptContext["runtime"]["connection"]["mutable"]["startupBinding"];
  toolSpecs: Parameters<typeof codexDynamicToolsFingerprint>[0];
  hasContinuation: boolean;
  continuationMessages: AgentMessage[] | undefined;
  preserveToolPayload: boolean;
  projectionParams: Omit<
    ProjectionParams,
    "assembledMessages" | "systemPromptAddition" | "toolPayloadMode"
  >;
  historyTokenBudget?: number;
  baseDeveloperInstructions: string;
  assertCurrent: () => void;
}) {
  const { assembled, projectionParams, startupBinding, assertCurrent } = params;
  const messages = [...assembled.messages, ...(params.continuationMessages ?? [])].filter(
    (message) =>
      (message.role !== "custom" || isCodexDurableCustomMessage(message)) &&
      !(
        message.role === "user" &&
        projectionParams.currentUserTurnIdempotencyKey &&
        Reflect.get(message, "idempotencyKey") === projectionParams.currentUserTurnIdempotencyKey
      ),
  );
  const configured = params.historyTokenBudget !== undefined;
  const selection = configured
    ? selectHistoryPrefix(
        messages,
        assembled.contextProjection,
        startupBinding?.contextEngine?.projection?.fingerprint,
      )
    : undefined;
  const contextEngineProjection =
    selection?.projection ??
    readContextEngineThreadBootstrapProjection(assembled.contextProjection);
  const projectionDecision =
    contextEngineProjection && !params.hasContinuation
      ? resolveContextEngineBootstrapProjectionDecision({
          startupBinding,
          expectedBinding: buildContextEngineBinding(params.runtimeParams, contextEngineProjection),
          dynamicToolsFingerprint: codexDynamicToolsFingerprint(params.toolSpecs),
          legacyDynamicToolsFingerprint: codexLegacyDynamicToolsFingerprint(params.toolSpecs),
        })
      : { project: true, reason: "per-turn-projection" };
  const renderProjection = (includeAttachments: boolean) =>
    projectContextEngineAssemblyForCodex({
      ...projectionParams,
      assembledMessages: configured ? [] : messages,
      systemPromptAddition: assembled.systemPromptAddition,
      toolPayloadMode: contextEngineProjection || params.preserveToolPayload ? "preserve" : "elide",
      prepareFileContext: includeAttachments ? projectionParams.prepareFileContext : undefined,
    });
  const projection = await renderProjection(projectionDecision.project);
  const historyBootstrapItems = configured
    ? await buildCodexSelectedHistoryItems({
        messages,
        tokenBudget: params.historyTokenBudget,
        prepareFileContext: projectionParams.prepareFileContext,
      })
    : undefined;
  const historyDeltaItems =
    configured && selection?.prefixLength !== undefined && !projectionDecision.project
      ? await buildCodexSelectedHistoryItems({
          messages: messages.slice(selection.prefixLength),
          tokenBudget: params.historyTokenBudget,
          prepareFileContext: projectionParams.prepareFileContext,
        })
      : undefined;
  assertCurrent();
  return {
    projection,
    projectionDecision,
    preparedBootstrapProjection:
      !configured && contextEngineProjection ? () => renderProjection(true) : undefined,
    promptState: {
      contextEngineProjection,
      historyBootstrapItems,
      historyDeltaItems,
      promptText:
        configured || projectionDecision.project ? projection.promptText : projectionParams.prompt,
      promptContextRange:
        !configured && projectionDecision.project ? projection.promptContextRange : undefined,
      developerInstructions: joinPresentSections(
        params.baseDeveloperInstructions,
        projection.developerInstructionAddition,
      ),
    },
  };
}

/** Append only an acknowledged prefix's suffix; fresh threads use the complete selection. */
export async function injectCodexHistoryDelta(
  params: CodexStartOrResumeThreadParams,
  options: {
    thread: CodexAppServerThreadLifecycleBinding;
    context: CodexThreadRequestContext;
    bindingIdentity: CodexAppServerBindingIdentity;
    authority: CodexBindingAuthority;
  },
): Promise<void> {
  const items = params.historyDeltaItems;
  if (!items?.length) {
    return;
  }
  const { thread, context, bindingIdentity, authority } = options;
  const { contextEngineBinding, lifecycleTiming, throwIfAborted } = context;
  const assert = authority.assertCurrent;
  throwIfAborted();
  assert();
  if (
    thread.model !== context.startModelSelection.model ||
    (context.startModelProvider && thread.modelProvider !== context.startModelProvider)
  ) {
    throw new Error(
      "Codex selected a different model than the assembled context policy; retry with that model's configured budget.",
    );
  }
  try {
    // A crash after append but before acknowledgement must rotate, never replay this suffix.
    const pendingContextEngine = contextEngineBinding?.projection
      ? {
          ...contextEngineBinding,
          projection: {
            ...contextEngineBinding.projection,
            fingerprint: `pending:${params.contextEngineProjection?.deliveredFingerprint}`,
          },
        }
      : undefined;
    const marked = await params.bindingStore.mutate(
      bindingIdentity,
      { kind: "patch", threadId: thread.threadId, patch: { contextEngine: pendingContextEngine } },
      assert,
      authority,
    );
    if (!marked) {
      throw new CodexThreadBindingConflictError(thread.threadId, "marking history delivery");
    }
    await lifecycleTiming.measure("thread-reuse-seed-history", () =>
      params.client.request(
        "thread/inject_items",
        { threadId: thread.threadId, items },
        {
          signal: params.signal,
          assertCurrent: () => {
            throwIfAborted();
            params.params.hostCapabilities.assertActive();
            assert();
          },
          withCurrent: authority.withCurrent,
        },
      ),
    );
    const acknowledged = buildContextEngineBinding(
      params.params,
      params.contextEngineProjection,
      true,
    );
    const committed = await params.bindingStore.mutate(
      bindingIdentity,
      { kind: "patch", threadId: thread.threadId, patch: { contextEngine: acknowledged } },
      assert,
      authority,
    );
    if (!committed) {
      throw new CodexThreadBindingConflictError(thread.threadId, "acknowledging history delivery");
    }
    thread.contextEngine = acknowledged;
  } catch (error) {
    // Preserve the native transcript but retire uncertain delivery from future reuse.
    await params.bindingStore.mutate(
      bindingIdentity,
      { kind: "clear", threadId: thread.threadId, clientId: thread.clientId },
      assert,
      authority,
    );
    if (!thread.liveThreadOwnership) {
      const released = await unsubscribeCodexThreadBestEffort(params.client, {
        threadId: thread.threadId,
        timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
        assertCurrent: assert,
        withCurrent: authority.withCurrent,
      });
      if (!released) {
        await (params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)))();
        throw new CodexAppServerUnsafeSubscriptionError("Codex reused history cleanup failed", {
          cause: error,
        });
      }
    }
    throw error;
  }
  throwIfAborted();
  assert();
}

/** A provisional thread must acknowledge its full selection before the binding can commit. */
export async function seedCodexHistory(
  params: CodexStartOrResumeThreadParams,
  options: {
    response: { thread: { id: string }; model?: string | null; modelProvider?: string | null };
    expectedModel: string | null | undefined;
    expectedProvider: string | null | undefined;
    lifecycleTiming: CodexThreadRequestContext["lifecycleTiming"];
    assertCurrent: () => void;
  },
): Promise<void> {
  const items = params.historyBootstrapItems;
  if (items === undefined) {
    return;
  }
  const { response, expectedModel, expectedProvider, lifecycleTiming, assertCurrent } = options;
  assertCurrent();
  if (
    !response.model ||
    response.model !== expectedModel ||
    (expectedProvider && response.modelProvider !== expectedProvider)
  ) {
    throw new Error(
      "Codex selected a different model than the assembled context policy; retry with that model's configured budget.",
    );
  }
  if (items.length) {
    await lifecycleTiming.measure("thread-start-seed-history", () =>
      params.client.request(
        "thread/inject_items",
        { threadId: response.thread.id, items },
        { signal: params.signal, assertCurrent, withCurrent: params.authority?.withCurrent },
      ),
    );
  }
  assertCurrent();
}
