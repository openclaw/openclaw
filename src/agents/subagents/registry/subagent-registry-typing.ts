import { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntrySourceAssertion } from "../../../config/sessions/session-entry-source-authority.js";
import type { PreparedSessionSourceAuthority } from "../../../config/sessions/session-source-authority.js";
import { sourceDeliveryTargetsMatch } from "../../../infra/outbound/source-delivery-plan.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { stringifyRouteThreadId } from "../../../plugin-sdk/channel-route.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { normalizeAccountId } from "../../../routing/account-id.js";
import { deliveryContextFromSession } from "../../../utils/delivery-context.read.js";
import type { SubagentCompletionCustody } from "./subagent-registry-memory.types.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const log = createSubsystemLogger("agents/subagent-typing");

/** Detached work borrows its captured requester authority, never a later session's route. */
export async function startSubagentTyping(
  entry: SubagentRunRecord,
  source: SubagentCompletionCustody["authority"] | undefined,
  currentEntry: () => SubagentRunRecord | undefined,
): Promise<void> {
  const origin = entry.requesterOrigin;
  const resolveGatewayContext = getGatewayContextResolver(entry);
  const runtime = resolveGatewayContext?.()?.lifecycleRuntime;
  if (
    !source ||
    origin?.channel !== "telegram" ||
    !origin.to ||
    entry.expectsCompletionMessage !== true ||
    entry.collect ||
    !entry.completionRequesterSessionId ||
    !entry.requesterAgentId ||
    !entry.requesterStorePath ||
    !runtime?.startTyping
  ) {
    return;
  }
  let stopped = false;
  let stopTyping: (() => void) | undefined;
  let session: PreparedSessionSourceAuthority | undefined;
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    unsubscribe();
    source.signal.removeEventListener("abort", stop);
    stopTyping?.();
    void session?.release?.();
  };
  const assertHostCurrent = () => {
    source.assertCurrent();
    const current = currentEntry();
    if (
      stopped ||
      !current ||
      current.execution.status !== "running" ||
      current.execution.endedAt !== undefined ||
      current.killIntent ||
      current.killReconciliation ||
      resolveGatewayContext?.()?.lifecycleRuntime !== runtime
    ) {
      throw new Error("Detached typing source is no longer active");
    }
  };
  const isCurrent = () => {
    try {
      assertHostCurrent();
      session?.assertCurrent();
      return true;
    } catch {
      stop();
      return false;
    }
  };
  const unsubscribe = subscribeSubagentRunChanges("projection", ({ runIds }) => {
    if (!runIds || runIds.includes(entry.runId)) {
      isCurrent();
    }
  });
  source.signal.addEventListener("abort", stop, { once: true });
  try {
    assertHostCurrent();
    const scope = {
      agentId: entry.requesterAgentId,
      sessionKey: entry.requesterSessionKey,
      storePath: entry.requesterStorePath,
    };
    const requester = await readSessionEntryReadOnlyInWorker(scope, assertHostCurrent);
    const route = deliveryContextFromSession(requester);
    if (
      requester?.sessionId !== entry.completionRequesterSessionId ||
      requester?.lifecycleRevision !== entry.completionRequesterLifecycleRevision ||
      !sourceDeliveryTargetsMatch(
        { ...origin, provider: origin.channel, threadId: stringifyRouteThreadId(origin.threadId) },
        route ?? {},
      ) ||
      normalizeAccountId(route?.accountId) !== normalizeAccountId(origin.accountId)
    ) {
      stop();
      return;
    }
    const prepared = await captureSessionEntrySourceAssertion({
      scope,
      expected: requester,
      fields: ["sessionId", "lifecycleRevision", "delivery"],
      assertCurrent: assertHostCurrent,
      assertHostCurrent,
      refuse: () => {
        throw new Error("Detached typing requester changed");
      },
    }).prepareSessionSource();
    if (stopped) {
      await prepared.release?.();
      return;
    }
    session = prepared;
    assertHostCurrent();
    stopTyping = runtime.startTyping({
      ...origin,
      channel: "telegram",
      to: origin.to,
      agentId: entry.requesterAgentId,
      runId: entry.runId,
      isCurrent,
    });
  } catch {
    stop();
    log.debug("detached typing unavailable; final delivery continues");
  }
}
