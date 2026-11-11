import type { CdpDocumentIdentities } from "../cdp-page-session.js";
import { getDocumentIdentitiesViaCdp } from "../cdp.js";
import type { BrowserTab } from "../client.types.js";
import { BrowserTabCrashedError } from "../errors.js";
import type { PwAiModule } from "../pw-ai-module.js";
import type { BrowserRouteContext } from "../server-context.js";
import { getProfileLifecycle } from "../server-context.lifecycle.js";

/** Optional metadata must not hide a terminal target failure behind a CDP fallback. */
export function ignoreUnavailableSnapshotMetadata(error: unknown): undefined {
  if (error instanceof BrowserTabCrashedError) {
    throw error;
  }
  return undefined;
}

export async function readSnapshotDocumentIdentities(opts: {
  tab: BrowserTab;
  cdpUrl: string;
  pwModule: PwAiModule | null;
  timeoutMs?: number;
}): Promise<CdpDocumentIdentities> {
  const readPlaywrightIdentities = opts.pwModule?.getDocumentIdentitiesViaPlaywright;
  const playwrightIdentities = readPlaywrightIdentities
    ? await readPlaywrightIdentities({
        cdpUrl: opts.cdpUrl,
        targetId: opts.tab.targetId,
        timeoutMs: opts.timeoutMs,
      }).catch(ignoreUnavailableSnapshotMetadata)
    : undefined;
  if (playwrightIdentities?.mainFrame || !opts.tab.wsUrl) {
    return playwrightIdentities ?? {};
  }
  return await getDocumentIdentitiesViaCdp({
    wsUrl: opts.tab.wsUrl,
    ...(opts.tab.wsLookup ? { lookup: opts.tab.wsLookup } : {}),
    timeoutMs: opts.timeoutMs,
  }).catch(() => ({}));
}

/** Pin capture at the actual bridge; a failed capture must never enable generic recovery. */
export async function captureBrowserOperationTarget(opts: {
  ctx: BrowserRouteContext;
  profileName: string;
  targetId: string;
}) {
  const state = opts.ctx.state();
  const relay = state.extensionRelays?.get(opts.profileName);
  if (!relay) {
    return undefined;
  }
  const runtime = state.profiles.get(opts.profileName);
  if (!runtime) {
    throw new Error("Browser operation profile is unavailable");
  }
  const lifecycle = getProfileLifecycle(runtime);
  const profileSignal = lifecycle.controller.signal;
  let released = false;
  const isCurrent = () =>
    !released &&
    opts.ctx.state() === state &&
    state.extensionRelays?.get(opts.profileName) === relay &&
    state.profiles.get(opts.profileName) === runtime &&
    !profileSignal.aborted;
  const reference =
    relay.ownership === "borrowed"
      ? await relay.client.capture(opts.targetId, () => {
          if (!isCurrent()) {
            throw new Error("Browser operation generation was superseded");
          }
        })
      : undefined;
  const resolveTarget =
    relay.ownership === "borrowed"
      ? reference?.resolve
      : relay.bridge.captureOperationTarget(opts.targetId);
  const resolve = async () => {
    if (!isCurrent()) {
      return undefined;
    }
    const target = await resolveTarget?.();
    return isCurrent() ? target : undefined;
  };
  return Object.assign(resolve, {
    reference,
    release: async () => {
      released = true;
      await reference?.release();
    },
  });
}

/** Report the acted-on target if its exact owner no longer exposes a replacement. */
export async function resolveOperationTargetOutcome(opts: {
  actedOnTargetId: string;
  operationTargetId?: string;
  resolveRelayTarget?: () => string | undefined | Promise<string | undefined>;
}): Promise<string> {
  return opts.resolveRelayTarget
    ? ((await opts.resolveRelayTarget()) ?? opts.actedOnTargetId)
    : (opts.operationTargetId ?? opts.actedOnTargetId);
}
