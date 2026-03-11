import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  streamAnthropic,
  type AnthropicOptions,
  type AnthropicEffort,
  type Model,
} from "@mariozechner/pi-ai";

/**
 * Create a StreamFn that routes through pi-ai's `streamAnthropic` with an
 * injected `AnthropicVertex` client.  All streaming, message conversion, and
 * event handling is handled by pi-ai — we only supply the GCP-authenticated
 * client and map SimpleStreamOptions → AnthropicOptions.
 */
export function createAnthropicVertexStreamFn(projectId: string, region: string): StreamFn {
  const client = new AnthropicVertex({ projectId, region });

  return (model, context, options) => {
    const opts: AnthropicOptions = {
      client: client as unknown as AnthropicOptions["client"],
      temperature: options?.temperature,
      maxTokens: options?.maxTokens || Math.min(model.maxTokens, 32000),
      signal: options?.signal,
      cacheRetention: options?.cacheRetention,
      sessionId: options?.sessionId,
      headers: options?.headers,
      onPayload: options?.onPayload,
      maxRetryDelayMs: options?.maxRetryDelayMs,
      metadata: options?.metadata,
    };

    if (options?.reasoning) {
      const isAdaptive =
        model.id.includes("opus-4-6") ||
        model.id.includes("opus-4.6") ||
        model.id.includes("sonnet-4-6") ||
        model.id.includes("sonnet-4.6");

      if (isAdaptive) {
        opts.thinkingEnabled = true;
        const effortMap: Record<string, AnthropicEffort> = {
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: model.id.includes("opus-4-6") || model.id.includes("opus-4.6") ? "max" : "high",
        };
        opts.effort = effortMap[options.reasoning] ?? "high";
      } else {
        opts.thinkingEnabled = true;
        const budgets = options.thinkingBudgets;
        opts.thinkingBudgetTokens =
          (budgets && options.reasoning in budgets
            ? budgets[options.reasoning as keyof typeof budgets]
            : undefined) ?? 10000;
      }
    } else {
      opts.thinkingEnabled = false;
    }

    return streamAnthropic(model as Model<"anthropic-messages">, context, opts);
  };
}
