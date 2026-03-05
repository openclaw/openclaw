/**
 * Wraps a StreamFn to emit before_llm_call plugin hooks.
 *
 * Uses the same streamFn wrapping pattern as cache-trace.ts and
 * anthropic-payload-log.ts — outermost wrapper sees the full context before
 * delegating to the underlying (possibly wrapped) streamFn.
 */
import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Message } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookRunner, PluginHookAgentContext } from "../../../plugins/hooks.js";

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
      try {
        const toolDefs = (context.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
        }));
        const result = await hookRunner.runBeforeLlmCall(
          {
            messages: context.messages as AgentMessage[],
            systemPrompt: context.systemPrompt ?? "",
            model: modelId,
            iteration: iterationRef.current,
            tools: toolDefs,
          },
          agentCtx,
        );

        if (result?.block) {
          const reason = result.blockReason ?? "blocked by before_llm_call hook";
          log.warn(`before_llm_call: blocked LLM call: ${reason}`);
          throw new BeforeLlmCallBlockError(reason);
        }

        // Apply modifications — only create new context if something changed
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
          // Spread original context to preserve any extra fields (e.g. provider
          // metadata) that upstream wrappers may have attached. Only override
          // the fields the hook explicitly modified.
          effectiveContext = {
            ...context,
            systemPrompt: result.systemPrompt ?? context.systemPrompt,
            messages: (result.messages ?? context.messages) as Message[],
            tools: filteredTools,
          };
        }
      } catch (err) {
        // Re-throw explicit block errors (sentinel class, not string matching)
        if (err instanceof BeforeLlmCallBlockError) {
          throw err;
        }
        log.warn(`before_llm_call hook failed: ${String(err)}`);
      }
    }

    // --- actual LLM call ---
    // streamFn may return sync EventStream or Promise<EventStream>.
    return streamFn(model, effectiveContext, options);
  };

  return wrapped;
}
