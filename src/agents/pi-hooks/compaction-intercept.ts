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
 *     SDK falls back as configured. NOTE: the SDK short-circuits on
 *     `{cancel: true}` (auth failure paths from safeguard) and never calls
 *     intercept in that case — engines cannot recover an auth-cancelled
 *     compaction event from this hook.
 *   - Registration is gated solely on `info.interceptsCompaction === true`
 *     in `extensions.ts`. Engines may declare BOTH `interceptsCompaction`
 *     and `ownsCompaction` because the two flags cover distinct
 *     compaction lanes (SDK event vs openclaw queued lane) — see the
 *     gate comment in `extensions.ts` and `pi-settings.ts`.
 *   - Skipped silently when no runtime is set (engine not resolved yet)
 *     or when `engine.interceptCompaction` is undefined (defensive guard
 *     for engines that mis-declare the capability flag without
 *     implementing the method).
 *   - Catches all thrown errors and falls back to the runtime's default
 *     path; the engine contract states `interceptCompaction` must not
 *     throw across the call boundary.
 */
export default function compactionInterceptExtension(api: ExtensionAPI): void {
  api.on("session_before_compact", async (event, ctx) => {
    const runtime = getCompactionInterceptRuntime(ctx.sessionManager);
    const engine = runtime?.contextEngine;
    if (!engine || typeof engine.interceptCompaction !== "function") {
      // Three skip cases collapse into one guard:
      //   1. no runtime registered for this session (e.g. inner LLM session)
      //   2. runtime present but no engine threaded through
      //   3. engine present but doesn't implement interceptCompaction
      // The `typeof === "function"` form narrows `engine.interceptCompaction`
      // to a non-undefined function while satisfying the typescript/unbound-method
      // lint rule (which would fire on a plain `!engine.interceptCompaction`
      // truthy access).
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

    // The pi-coding-agent SDK event does not currently carry an explicit
    // trigger field — codex's in-attempt-auto, overflow-retry, and manual
    // /compact all dispatch into the same `session_before_compact` handler
    // chain. Engines that condition on `request.trigger` should treat
    // `undefined` as "host couldn't disambiguate" and apply default cadence.
    // When the SDK surface grows to expose a real trigger, plumb it here.
    const trigger: CompactionInterceptRequest["trigger"] = undefined;

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
      // Call on the engine directly (preserves `this` binding without
      // triggering the unbound-method lint rule).
      result = await engine.interceptCompaction(request);
    } catch (error) {
      log.warn(
        `[compaction-intercept] engine.interceptCompaction threw — falling back to default compaction path. ${String(error)}`,
      );
      return undefined;
    }

    if (!result || !result.handled) {
      if (result && !result.handled) {
        log.debug(`[compaction-intercept] engine declined intercept: ${result.reason}`);
      }
      return undefined;
    }

    log.info("[compaction-intercept] engine handled compaction intercept", {
      engineId: engine.info.id,
      sessionId,
      sessionKey: runtime.sessionKey,
      tokenBudget,
      currentTokenCount,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      firstKeptEntryId: result.firstKeptEntryId,
      summaryChars: result.summary.length,
    });

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
