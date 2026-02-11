/**
 * Wraps a StreamFn to emit before_llm_call and context_assembled plugin hooks.
 *
 * Uses the same streamFn wrapping pattern as cache-trace.ts and
 * anthropic-payload-log.ts — outermost wrapper sees the full context before
 * delegating to the underlying (possibly wrapped) streamFn.
 */
import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Message } from "@mariozechner/pi-ai";
import type { HookRunner, PluginHookAgentContext } from "../../../plugins/hooks.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("hooks/stream");

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
  let contextAssembledEmitted = false;

  const wrapped: StreamFn = async (model, context, options) => {
    // --- context_assembled (first LLM call only) ---
    if (!contextAssembledEmitted && hookRunner.hasHooks("context_assembled")) {
      contextAssembledEmitted = true;
      try {
        await hookRunner.runContextAssembled(
          {
            systemPrompt: context.systemPrompt ?? "",
            messages: context.messages as AgentMessage[],
            messageCount: context.messages.length,
            iteration: iterationRef.current,
          },
          agentCtx,
        );
      } catch (err) {
        log.warn(`context_assembled hook failed: ${String(err)}`);
      }
    }

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
          throw new Error(`LLM call blocked by plugin: ${reason}`);
        }

        // Apply modifications — only create new context if something changed
        if (result?.messages || result?.systemPrompt || result?.tools) {
          const filteredTools = result.tools
            ? (() => {
                const allowedNames = new Set(result.tools!.map((t) => t.name));
                return (context.tools ?? []).filter((t) => allowedNames.has(t.name));
              })()
            : context.tools;
          effectiveContext = {
            systemPrompt: result.systemPrompt ?? context.systemPrompt,
            messages: (result.messages ?? context.messages) as Message[],
            tools: filteredTools,
          };
        }
      } catch (err) {
        // Re-throw explicit block errors
        if ((err as Error)?.message?.startsWith("LLM call blocked by plugin:")) {
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
