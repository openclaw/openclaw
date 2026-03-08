/**
 * Wraps a StreamFn to emit before_llm_call and after_llm_call plugin hooks.
 *
 * Uses the same streamFn wrapping pattern as cache-trace.ts and
 * anthropic-payload-log.ts — outermost wrapper sees the full context before
 * delegating to the underlying (possibly wrapped) streamFn.
 *
 * ## after_llm_call: deterministic gate via response interception
 *
 * The wrapper intercepts the LLM response stream's completion event.
 * When the response contains tool calls, it fires runAfterLlmCall and
 * stores the resulting Promise in the gate (after-llm-call-gate.ts).
 *
 * This runs inside streamAssistantResponse() in agentLoop's async context.
 * Since executeToolCalls() is called sequentially after streamAssistantResponse()
 * returns, the Promise is guaranteed to exist when tools start executing.
 * The tool wrapper (pi-tools.before-tool-call.ts) awaits the Promise,
 * making enforcement deterministic.
 */
import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessageEvent, Context, Message } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookRunner, PluginHookAgentContext } from "../../../plugins/hooks.js";
import { setAfterLlmCallGatePromise, clearAfterLlmCallGate } from "./after-llm-call-gate.js";

const log = createSubsystemLogger("hooks/stream");

/**
 * Sentinel error thrown when before_llm_call blocks the LLM call.
 * Distinct from generic errors so the agent loop can handle it gracefully
 * (suppress the run without surfacing an error) rather than treating it
 * as a run failure.
 */
export class BeforeLlmCallBlockError extends Error {
  readonly isBeforeLlmCallBlock = true;
  constructor(reason: string) {
    super(`LLM call blocked by plugin: ${reason}`);
    this.name = "BeforeLlmCallBlockError";
  }
}

export interface HookStreamWrapperParams {
  hookRunner: HookRunner;
  agentCtx: PluginHookAgentContext;
  /** Mutable ref so the wrapper always reads the current iteration count */
  iterationRef: { current: number };
  /** Model identifier string */
  modelId: string;
  /** Session ID for after_llm_call gate keying. Required when after_llm_call hooks are registered. */
  sessionId?: string;
}

export function wrapStreamFnWithHooks(
  streamFn: StreamFn,
  params: HookStreamWrapperParams,
): StreamFn {
  const { hookRunner, agentCtx, iterationRef, modelId } = params;
  const wrapped: StreamFn = async (model, context, options) => {
    // --- before_llm_call ---
    let effectiveContext: Context = context;
    if (hookRunner.hasHooks("before_llm_call")) {
      const toolDefs = (context.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
      }));
      let result: Awaited<ReturnType<typeof hookRunner.runBeforeLlmCall>> | undefined;
      try {
        result = await hookRunner.runBeforeLlmCall(
          {
            messages: context.messages as AgentMessage[],
            systemPrompt: context.systemPrompt ?? "",
            model: modelId,
            iteration: iterationRef.current,
            tools: toolDefs,
          },
          agentCtx,
        );
      } catch (err) {
        // Fail-open: log and continue with the original context.
        log.warn(`before_llm_call hook failed: ${String(err)}`);
      }

      // Block check is outside the try-catch — fail-open only applies to
      // hook execution errors, not to an explicit block decision.
      if (result?.block) {
        const reason = result.blockReason ?? "blocked by before_llm_call hook";
        log.warn(`before_llm_call: blocked LLM call: ${reason}`);
        throw new BeforeLlmCallBlockError(reason);
      }

      // Apply modifications — only create new context if something changed.
      // Use !== undefined consistently: any explicit value (including [] or "")
      // means the hook wants that exact value. Return undefined for "no change".
      if (
        result?.messages !== undefined ||
        result?.systemPrompt !== undefined ||
        result?.tools !== undefined
      ) {
        let filteredTools = context.tools;
        if (result.tools !== undefined) {
          const allowedNames = new Set(result.tools.map((t) => t.name));
          filteredTools = (context.tools ?? []).filter((t) => allowedNames.has(t.name));
        }
        effectiveContext = {
          ...context,
          systemPrompt: result.systemPrompt ?? context.systemPrompt,
          messages: (result.messages ?? context.messages) as Message[],
          tools: filteredTools,
        };
      }
    }

    // --- actual LLM call ---
    // streamFn may return sync EventStream or Promise<EventStream>.
    const responseStream = await Promise.resolve(streamFn(model, effectiveContext, options));

    // --- after_llm_call: intercept response completion ---
    // Wrap the async iterator to detect the final message and fire the hook.
    // The gate Promise is set synchronously (before this function returns),
    // guaranteeing it exists when executeToolCalls starts.
    if (hookRunner.hasHooks("after_llm_call") && params.sessionId) {
      const sessionId = params.sessionId;
      // Clear any stale gate from a previous turn/message_end in this session.
      clearAfterLlmCallGate(sessionId);

      const originalIterator = responseStream[Symbol.asyncIterator]();
      const wrappedIterator: AsyncIterator<AssistantMessageEvent> = {
        async next() {
          const result = await originalIterator.next();
          if (!result.done) {
            const event = result.value as AssistantMessageEvent & {
              type: string;
              partial?: AgentMessage;
            };
            // Detect response completion (done/error events carry the final message).
            if (event.type === "done" || event.type === "error") {
              const finalMessage =
                event.type === "done"
                  ? (event as unknown as { message: AgentMessage }).message
                  : undefined;
              if (finalMessage) {
                fireAfterLlmCallGate(
                  hookRunner,
                  agentCtx,
                  finalMessage,
                  iterationRef.current,
                  modelId,
                  sessionId,
                );
              }
            }
          }
          return result;
        },
        return: originalIterator.return?.bind(originalIterator),
        throw: originalIterator.throw?.bind(originalIterator),
      };

      // Replace the async iterator on the stream object.
      (responseStream as unknown as Record<symbol, () => AsyncIterator<AssistantMessageEvent>>)[
        Symbol.asyncIterator
      ] = () => wrappedIterator;
    }

    return responseStream as ReturnType<StreamFn> extends Promise<infer R>
      ? R
      : ReturnType<StreamFn>;
  };

  return wrapped;
}

/** Helper to detect tool call content blocks in an assistant message.
 *  Covers all variants: pi-agent-core normalized (toolCall), provider-specific
 *  (tool_use for Anthropic, tool_call for OpenAI), and legacy (toolUse, functionCall). */
function isToolCallBlockType(type: unknown): boolean {
  return (
    type === "toolCall" ||
    type === "tool_call" ||
    type === "tool_use" ||
    type === "toolUse" ||
    type === "functionCall"
  );
}

/**
 * Extract tool calls from the final assistant message and fire the
 * after_llm_call hook. The resulting Promise is stored in the gate
 * synchronously — before streamAssistantResponse returns.
 */
function fireAfterLlmCallGate(
  hookRunner: HookRunner,
  agentCtx: PluginHookAgentContext,
  finalMessage: AgentMessage,
  iteration: number,
  modelId: string,
  sessionId: string,
): void {
  // Extract tool calls from the message content.
  const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  const msg = finalMessage as unknown as { content?: Array<Record<string, unknown>> };
  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part && isToolCallBlockType(part.type)) {
        toolCalls.push({
          id: (part.id as string) ?? "",
          name: (part.name as string) ?? "",
          // Some providers use `input` (Anthropic tool_use) instead of `arguments`
          arguments:
            (part.arguments as Record<string, unknown>) ??
            (part.input as Record<string, unknown>) ??
            {},
        });
      }
    }
  }

  if (toolCalls.length === 0) {
    return; // No tools to gate — skip hook entirely.
  }

  // Fire the hook and store the Promise in the gate. The Promise is set
  // synchronously here (before streamAssistantResponse returns), even though
  // the hook itself may be async. The tool wrapper will await it.
  const hookPromise = hookRunner.runAfterLlmCall(
    {
      response: finalMessage,
      toolCalls,
      iteration,
      model: modelId,
    },
    agentCtx,
  );

  setAfterLlmCallGatePromise(sessionId, hookPromise);
}
