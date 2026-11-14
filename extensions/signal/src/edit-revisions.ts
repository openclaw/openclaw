import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeSignalMessagingTarget } from "./normalize.js";
import { getOptionalSignalRuntime } from "./runtime.js";

// Official Signal clients aim every later edit at the newest revision. Signal-Android moves
// reactions and pins from the revision an edit names, so re-targeting the original drops them.
// Each timestamp in an edit chain maps to the chain's original message; the original maps to
// the newest revision. Plugin state (not process memory) so CLI sends and Gateway runs share it.
const NAMESPACE = "signal.edit-revisions.v1";
const MAX_ENTRIES = 2000;
// Signal accepts edits for 24 hours; keep chains a little longer.
const TTL_MS = 2 * 24 * 60 * 60 * 1000;

type SignalEditChainRecord = { root: number; latest: number };

type SignalEditTarget = { accountId?: string | null; to: string; timestamp: number };

function warn(stage: string, error: unknown): void {
  getOptionalSignalRuntime()
    ?.logging.getChildLogger({ plugin: "signal", feature: "edit-revisions" })
    .warn(`Signal edit revision ${stage} failed; the edit targets the given messageId`, {
      error: String(error),
    });
}

function openStore() {
  const runtime = getOptionalSignalRuntime();
  try {
    return runtime?.state.openKeyedStoreV2<SignalEditChainRecord>({
      namespace: NAMESPACE,
      maxEntries: MAX_ENTRIES,
      defaultTtlMs: TTL_MS,
    });
  } catch (error) {
    warn("state", error);
    return undefined;
  }
}

function chainKey(params: SignalEditTarget, timestamp: number): string {
  const account = normalizeLowercaseStringOrEmpty(params.accountId ?? DEFAULT_ACCOUNT_ID);
  const to = normalizeSignalMessagingTarget(params.to) ?? params.to;
  return `account=${account}|to=${to}|ts=${timestamp}`;
}

/** Returns the timestamp an edit of `timestamp` must target: the newest known revision. */
export async function resolveSignalEditTarget(params: SignalEditTarget): Promise<number> {
  const store = openStore();
  try {
    const record = await store?.lookup(chainKey(params, params.timestamp));
    if (!record) {
      return params.timestamp;
    }
    const root = await store?.lookup(chainKey(params, record.root));
    return root?.latest ?? record.latest;
  } catch (error) {
    warn("lookup", error);
    return params.timestamp;
  }
}

/** Records `revision` as the newest revision of the chain `params.timestamp` belongs to. */
export async function recordSignalEditRevision(
  params: SignalEditTarget & { revision: number },
): Promise<void> {
  const store = openStore();
  if (!store) {
    return;
  }
  try {
    const root = (await store.lookup(chainKey(params, params.timestamp)))?.root ?? params.timestamp;
    const record = { root, latest: params.revision };
    for (const timestamp of new Set([root, params.timestamp, params.revision])) {
      await store.register(chainKey(params, timestamp), record);
    }
  } catch (error) {
    warn("record", error);
  }
}
