/**
 * Small reset API/queue surface for after-compaction plugin hooks.
 */
import { formatErrorMessage } from "../../infra/errors.js";
import type { PluginHookAgentContext } from "../../plugins/types.js";
import { log } from "./logger.js";

export type EmbeddedHookApi = NonNullable<PluginHookAgentContext["api"]>;
type EmbeddedHookSessionResetReason = "new" | "reset";
type DeferredEmbeddedHookSessionResetRequest = {
  key: string;
  agentId?: string;
  reason: EmbeddedHookSessionResetReason;
  commandSource: string;
  assertCurrent?: () => void;
  onCommitted?: (commit: { key: string; sessionId: string }) => void;
};
export type DeferEmbeddedHookSessionReset = (
  request: DeferredEmbeddedHookSessionResetRequest,
) => void;
type HookResetSessionFunction = EmbeddedHookApi["resetSession"];

export function withEmbeddedHookSessionResetAssertion(
  request: DeferredEmbeddedHookSessionResetRequest,
  assertCurrent: () => void,
): DeferredEmbeddedHookSessionResetRequest {
  return {
    ...request,
    assertCurrent: () => {
      request.assertCurrent?.();
      assertCurrent();
    },
  };
}

export function buildEmbeddedHookApi(params?: {
  agentId?: string;
  sessionKey?: string;
  commandSource?: string;
  deferResetSession?: DeferEmbeddedHookSessionReset;
}): EmbeddedHookApi {
  const sessionKey = params?.sessionKey?.trim();
  const resetSession: HookResetSessionFunction = async (reason: unknown = "reset") => {
    if (reason !== "new" && reason !== "reset") {
      throw new Error('resetSession only accepts reason "new" or "reset"');
    }
    if (!sessionKey) {
      throw new Error("resetSession is unavailable without a current session key");
    }
    if (!params?.deferResetSession) {
      throw new Error("resetSession is unavailable without a deferred lifecycle owner");
    }
    params.deferResetSession({
      key: sessionKey,
      ...(params?.agentId ? { agentId: params.agentId } : {}),
      reason,
      commandSource: params?.commandSource ?? "embedded-agent:hook",
    });
    return { ok: true, key: sessionKey, deferred: true };
  };
  return {
    resetSession,
  };
}

export function createEmbeddedHookSessionResetQueue() {
  const pending = new Map<string, DeferredEmbeddedHookSessionResetRequest>();
  return {
    deferResetSession(request: DeferredEmbeddedHookSessionResetRequest): void {
      pending.set(request.key, request);
    },
    async flush(): Promise<void> {
      const requests = Array.from(pending.values());
      pending.clear();
      if (requests.length === 0) {
        return;
      }
      const { performGatewaySessionReset } = await import("../../gateway/session-reset-service.js");
      for (const request of requests) {
        try {
          const result = await performGatewaySessionReset(request);
          if (!result.ok) {
            log.warn("deferred embedded hook session reset failed", {
              key: request.key,
              errorMessage: result.error.message,
            });
          }
        } catch (err) {
          log.warn("deferred embedded hook session reset failed", {
            key: request.key,
            errorMessage: formatErrorMessage(err),
          });
        }
      }
    },
  };
}
