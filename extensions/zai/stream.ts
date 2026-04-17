import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  composeProviderStreamWrappers,
  createToolStreamWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";

// Upper bound for an injected X-Session-Id value. Header names/values have no
// protocol cap here, but a stricter bound guards against accidentally forwarding
// oversized session identifiers if the upstream model later tightens validation.
const MAX_SESSION_ID_LENGTH = 256;

function isInjectableSessionId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (value.length === 0 || value.length > MAX_SESSION_ID_LENGTH) {
    return false;
  }
  return value.trim().length > 0;
}

/**
 * Inject `X-Session-Id` from `options.sessionId` into request headers so the
 * z.ai load balancer can route cache-prefix-identical turns to the same
 * inference node. Per ZhipuAI support team's recommended best practice for
 * prompt cache stickiness; analogous to OpenAI's `prompt_cache_key` and xAI's
 * `x-grok-conv-id`.
 */
export function createZaiSessionIdHeaderWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const sessionId = (options as { sessionId?: unknown } | undefined)?.sessionId;
    if (!isInjectableSessionId(sessionId)) {
      return underlying(model, context, options);
    }
    return underlying(model, context, {
      ...options,
      headers: {
        ...options?.headers,
        "X-Session-Id": sessionId,
      },
    });
  };
}

export function wrapZaiProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  const toolStreamEnabled = ctx.extraParams?.tool_stream !== false;
  return composeProviderStreamWrappers(ctx.streamFn, (streamFn) => {
    const toolStreamWrapped = createToolStreamWrapper(streamFn, toolStreamEnabled);
    return createZaiSessionIdHeaderWrapper(toolStreamWrapped);
  });
}
