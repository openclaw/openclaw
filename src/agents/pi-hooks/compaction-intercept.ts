import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  CompactionInterceptRequest,
  CompactionInterceptResult,
} from "../../context-engine/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getCompactionInterceptRuntime } from "./compaction-intercept-runtime.js";

const log = createSubsystemLogger("compaction-intercept");

/**
 * Extension factory that bridges the pi-coding-agent `session_before_compact`
 * event to a context-engine plugin's optional
 * {@link import("../../context-engine/types.js").ContextEngine.interceptCompaction}
 * method.
 *
 * Wiring:
 *   - Registered AFTER `compactionSafeguardExtension` so that when both are
 *     active, the SDK's last-truthy-wins semantics let intercept override
 *     safeguard. When intercept returns `undefined` (handled:false or no
 *     engine), the safeguard's prior return (if any) is preserved and the
 *     SDK falls back as configured.
 *   - Skipped silently when no runtime is set (e.g. engine not resolved yet
 *     or engine does not advertise `info.interceptsCompaction`).
 *   - Skipped silently when `engine.interceptCompaction` is undefined (which
 *     should not happen if the engine correctly sets `info.interceptsCompaction`
 *     but we keep the defensive check).
 *   - Catches all thrown errors and falls back to the runtime's default path;
 *     the engine contract states `interceptCompaction` must not throw.
 *
 * This extension is a no-op for engines that fully own compaction
 * (`info.ownsCompaction === true`) — those engines bypass the
 * `session_before_compact` event entirely via the engine-owned compaction
 * dispatch path in `compact.queued.ts`.
 */
export default function compactionInterceptExtension(api: ExtensionAPI): void {
  api.on("session_before_compact", async (event, ctx) => {
    const runtime = getCompactionInterceptRuntime(ctx.sessionManager);
    const engine = runtime?.contextEngine;
    if (!engine?.interceptCompaction) {
      return undefined;
    }

    // Extract the runtime-level identifiers from the session manager so the
    // engine can route on sessionId/sessionFile without needing the SDK event
    // type directly. `sessionKey` is an openclaw-level concept not surfaced
    // by ReadonlySessionManager — engines that need it can derive it from
    // sessionFile path conventions or fall back to sessionId-only routing.
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    const contextUsage = ctx.getContextUsage();
    const tokenBudget = contextUsage?.contextWindow;
    const currentTokenCount =
      typeof contextUsage?.tokens === "number" ? contextUsage.tokens : undefined;

    const request: CompactionInterceptRequest = {
      sessionId,
      sessionFile,
      tokenBudget,
      currentTokenCount,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      signal: event.signal,
    };

    let result: CompactionInterceptResult;
    try {
      result = await engine.interceptCompaction(request);
    } catch (error) {
      log.warn(
        `[compaction-intercept] engine.interceptCompaction threw — falling back to default compaction path. ${String(error)}`,
      );
      return undefined;
    }

    if (!result || result.handled !== true) {
      if (result && result.handled === false) {
        log.debug(`[compaction-intercept] engine declined intercept: ${result.reason}`);
      }
      return undefined;
    }

    return {
      compaction: {
        summary: result.summary,
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
        details: result.details,
      },
    };
  });
}
