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
    const interceptFn = engine?.interceptCompaction;
    // Bind all three locals separately so TypeScript narrows each one in
    // isolation — chained optional access on the property `engine.interceptCompaction`
    // doesn't propagate to subsequent independent property reads on `engine`.
    if (!runtime || !engine || !interceptFn) {
      return undefined;
    }

    // Extract the runtime-level identifiers from the session manager so the
    // engine can route on sessionId/sessionFile without needing the SDK event
    // type directly. `sessionKey` (an openclaw-level concept) is carried
    // through the runtime registry because ReadonlySessionManager does not
    // expose it.
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (typeof sessionFile !== "string" || sessionFile.length === 0) {
      // pi-coding-agent's getSessionFile() returns string | undefined for
      // not-yet-persisted sessions. Without a session file the engine
      // cannot read raw history; bail and let the runtime fall back.
      log.debug(
        "[compaction-intercept] session has no on-disk file; falling back to default compaction path",
      );
      return undefined;
    }
    const contextUsage = ctx.getContextUsage();
    const tokenBudget = contextUsage?.contextWindow;
    const currentTokenCount =
      typeof contextUsage?.tokens === "number" ? contextUsage.tokens : undefined;

    // Resolve trigger from the SDK event when available. The pi-coding-agent
    // event currently does not carry an explicit trigger field; engines may
    // use the absence of trigger as "unknown source" and apply default policy.
    // Reserved for forward compatibility with future SDK extensions.
    const trigger = inferTriggerFromEvent(event);

    const request: CompactionInterceptRequest = {
      sessionId,
      sessionKey: runtime.sessionKey,
      sessionFile,
      tokenBudget,
      currentTokenCount,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      trigger,
      signal: event.signal,
    };

    let result: CompactionInterceptResult;
    try {
      result = await interceptFn.call(engine, request);
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

/**
 * Best-effort trigger inference from the SDK event. The current
 * pi-coding-agent event surface does not carry an explicit trigger; the
 * presence of a `previousSummary` indicates a redistill / re-compact while
 * its absence indicates a fresh-compact. Engines may use this signal for
 * cadence routing — overflow/in-attempt-auto/manual all collapse to
 * `"in-attempt-auto"` from the openclaw side until the SDK surface grows.
 */
function inferTriggerFromEvent(
  event: { preparation?: { previousSummary?: string } } | undefined,
): "in-attempt-auto" | "overflow" | "timeout" | "manual" | undefined {
  if (!event || !event.preparation) return undefined;
  return "in-attempt-auto";
}
