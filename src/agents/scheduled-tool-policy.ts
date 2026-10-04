import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeCronScheduledToolCallerOrigin,
  normalizeCronScheduledToolPolicy,
  type CronScheduledToolCallerOrigin,
  type CronScheduledToolPolicy,
} from "../cron/scheduled-tool-policy.js";

/** Trusted owner context used to resolve current agent and channel permissions. */
export type ScheduledToolPolicyContext = (
  | Extract<CronScheduledToolPolicy, { mode: "trusted" }>
  | (Extract<CronScheduledToolPolicy, { mode: "account" }> & {
      /** Missing legacy runtime contexts are treated as unknown and fail closed. */
      ownerOrigin?: CronScheduledToolCallerOrigin;
    })
) & {
  /** Restrict-only policy for the rebuilt exec tool; absence keeps baseline exec. */
  execTarget?: { host: "gateway"; ask?: "always" };
};

/** Separates a scheduled creator's authorization identity from its delivery route. */
export function resolveScheduledToolCallerContext(params: {
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  accountId?: string;
  channel?: string;
}): { accountId?: string; channel?: string | null; local?: true; scheduled?: true } {
  const policy = params.scheduledToolPolicy;
  const origin = policy?.mode === "account" ? policy.ownerOrigin : undefined;
  return {
    accountId: policy?.ownerAccountId ?? params.accountId,
    ...(policy ? { scheduled: true as const } : {}),
    ...(origin?.kind === "local" ? { local: true as const } : {}),
    channel:
      origin?.kind === "external"
        ? origin.channel
        : origin?.kind === "local"
          ? undefined
          : policy?.mode === "account"
            ? null
            : params.channel,
  };
}

/** Builds owner context independently of retired per-job tool snapshots. */
export function resolveScheduledToolPolicyContext(params: {
  toolsAllow?: readonly string[];
  scheduledToolPolicy?: unknown;
  callerOrigin?: unknown;
  execTarget?: unknown;
}): ScheduledToolPolicyContext | undefined {
  const rawPolicy = params.scheduledToolPolicy;
  // Already-resolved contexts carry context-only fields (ownerOrigin,
  // execTarget) that the strict persisted-policy normalizer rejects; rebuild
  // the closed policy shape for both modes before normalizing.
  const policy = normalizeCronScheduledToolPolicy(
    isRecord(rawPolicy) && rawPolicy.mode === "account"
      ? {
          version: rawPolicy.version,
          mode: rawPolicy.mode,
          ownerSessionKey: rawPolicy.ownerSessionKey,
          ownerAccountId: rawPolicy.ownerAccountId,
        }
      : isRecord(rawPolicy) && rawPolicy.mode === "trusted"
        ? { version: rawPolicy.version, mode: rawPolicy.mode }
        : rawPolicy,
  );
  if (!policy) {
    return undefined;
  }
  if (policy.mode === "trusted") {
    return policy;
  }
  return {
    ...policy,
    ownerOrigin: normalizeCronScheduledToolCallerOrigin(
      (isRecord(rawPolicy) ? rawPolicy.ownerOrigin : undefined) ?? params.callerOrigin,
    ),
  };
}
