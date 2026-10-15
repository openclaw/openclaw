import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_AUTHOR_DAYS = 10_000;
// The ingress completion journal suppresses old replays; this ring deduplicates active retries.
const RECENT_REJECTED_POSTS = 128;
export const MAX_X_GUEST_MENTIONS_PER_AUTHOR_PER_DAY = 1_000;

type XGuestUsage = {
  admittedPostIds: string[];
  rateLimited: number;
  recentRejectedPostIds: string[];
};

export class XGuestUsageUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "XGuestUsageUnavailableError";
  }
}

function accountDayPrefix(accountId: string, time = Date.now()) {
  return `${encodeURIComponent(accountId)}:${new Date(time).toISOString().slice(0, 10)}:`;
}

export function openXGuestUsage(runtime: {
  state: Pick<PluginRuntime["state"], "openKeyedStore" | "resolveStateDir">;
}) {
  const store = runtime.state.openKeyedStore<XGuestUsage>({
    namespace: "x.guest-usage",
    maxEntries: MAX_AUTHOR_DAYS,
    overflowPolicy: "reject-new",
    defaultTtlMs: 2 * DAY_MS,
  });
  return {
    async admit(params: {
      accountId: string;
      authorId: string;
      postId: string;
      limit: number;
      assertCurrent: () => void;
    }): Promise<boolean> {
      if (
        !Number.isInteger(params.limit) ||
        params.limit < 0 ||
        params.limit > MAX_X_GUEST_MENTIONS_PER_AUTHOR_PER_DAY
      ) {
        throw new XGuestUsageUnavailableError(
          "X guest mode requires a daily mention limit from 0 to 1000.",
        );
      }
      if (!store.withCurrent) {
        throw new XGuestUsageUnavailableError(
          "X guest mode requires host-enforced atomic usage accounting.",
        );
      }
      const now = Date.now();
      const prefix = accountDayPrefix(params.accountId, now);
      const assertCurrent = () => {
        params.assertCurrent();
        if (accountDayPrefix(params.accountId) !== prefix) {
          throw new Error("X guest usage day changed during admission; retrying mention");
        }
      };
      const writer = store.withCurrent({ assertCurrent });
      const key = `${prefix}${params.authorId}`;
      let observed = await writer.observe(key);
      if (params.limit > 0) {
        // A retried ingress claim keeps its admission across midnight while the usage row is retained.
        const previous = await Promise.all(
          [1, 2].map((days) =>
            writer.lookup(
              `${accountDayPrefix(params.accountId, now - days * DAY_MS)}${params.authorId}`,
            ),
          ),
        );
        if (previous.some((row) => row?.admittedPostIds.includes(params.postId))) {
          assertCurrent();
          return true;
        }
      }
      for (;;) {
        assertCurrent();
        const current = observed.value ?? {
          admittedPostIds: [],
          rateLimited: 0,
          recentRejectedPostIds: [],
        };
        if (params.limit > 0 && current.admittedPostIds.includes(params.postId)) {
          return true;
        }
        const admitted = current.admittedPostIds.length < params.limit;
        if (!admitted && current.recentRejectedPostIds.includes(params.postId)) {
          return false;
        }
        const next: XGuestUsage = admitted
          ? { ...current, admittedPostIds: [...current.admittedPostIds, params.postId] }
          : {
              ...current,
              rateLimited: current.rateLimited + 1,
              recentRejectedPostIds: [...current.recentRejectedPostIds, params.postId].slice(
                -RECENT_REJECTED_POSTS,
              ),
            };
        try {
          const result = await writer.compareAndApply(key, observed.comparison, {
            operation: "update",
            action: "set",
            value: next,
          });
          if (result.status !== "conflict") {
            return admitted;
          }
          observed = result.current;
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "PLUGIN_STATE_LIMIT_EXCEEDED"
          ) {
            throw new XGuestUsageUnavailableError(
              "X guest mode is paused because usage accounting reached capacity; retry after retained usage expires.",
              { cause: error },
            );
          }
          throw error;
        }
      }
    },
    async counts(accountId: string): Promise<{ admittedToday: number; rateLimitedToday: number }> {
      if (!store.entriesInKeyRange) {
        throw new XGuestUsageUnavailableError("X guest mode requires bounded host usage reads.");
      }
      const prefix = accountDayPrefix(accountId);
      const rows = await store.entriesInKeyRange({
        keyStartInclusive: prefix,
        keyEndExclusive: `${prefix}\uffff`,
        limit: MAX_AUTHOR_DAYS,
      });
      return rows.reduce(
        (counts, row) => ({
          admittedToday: counts.admittedToday + row.value.admittedPostIds.length,
          rateLimitedToday: counts.rateLimitedToday + row.value.rateLimited,
        }),
        { admittedToday: 0, rateLimitedToday: 0 },
      );
    },
  };
}
