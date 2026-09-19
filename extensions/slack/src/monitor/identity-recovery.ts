// Slack plugin module owns runtime identity adoption and post-boot re-resolution.
import type { WebClientOptions } from "@slack/web-api";
import { computeBackoff, sleepWithAbort, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withSlackLifecycleSignal } from "../client-options.js";
import { createSlackStartupAuthClient } from "../client.js";
import type { SlackMonitorContext } from "./context.js";
import {
  resolveSlackIdentityHealth,
  resolveSlackInstallationIdentity,
  type SlackInstallationIdentity,
} from "./enterprise-install.js";
import { formatUnknownError, isNonRecoverableSlackAuthError } from "./reconnect-policy.js";

// Identity re-resolution after a failed startup auth.test. Without it, mention
// detection stays disabled until the next socket restart, which a healthy
// long-lived connection may never trigger.
const SLACK_IDENTITY_RECOVERY_POLICY = {
  initialMs: 10_000,
  maxMs: 600_000,
  factor: 2,
  jitter: 0.25,
} as const;

export type SlackIdentityRecoveryOutcome = "adopted" | "not-blocked" | "retry" | "unrecoverable";

type SlackRuntimeIdentity = {
  botUserId: string;
  botId?: string;
};

export function resolveSlackRuntimeIdentity(params: {
  identity: "bot" | "user";
  botUserId?: unknown;
  botId?: unknown;
}): SlackRuntimeIdentity | undefined {
  // User identity has no bot_id; its human id is both the mention target and self-send dedupe
  // source. Bot identity stays bot_id-gated so token mismatches fail closed.
  const botUserId = normalizeOptionalString(params.botUserId);
  const botId = normalizeOptionalString(params.botId);
  if (!botUserId || (params.identity === "bot" && !botId)) {
    return undefined;
  }
  return {
    botUserId,
    ...(botId ? { botId } : {}),
  };
}

export function applySlackInstallationIdentity(
  ctx: SlackMonitorContext,
  identity: SlackInstallationIdentity,
) {
  ctx.installationIdentity = identity;
  ctx.teamId = identity.kind === "workspace" ? identity.teamId : "";
  ctx.apiAppId = identity.kind === "degraded" ? "" : (identity.apiAppId ?? "");
}

export function adoptSlackIdentity(params: {
  ctx: SlackMonitorContext;
  identity: "bot" | "user";
  installationIdentity: SlackInstallationIdentity;
  botUserId?: unknown;
  botId?: unknown;
}): boolean {
  if (
    params.ctx.identityHealth.lifecycle !== "blocked" ||
    params.installationIdentity.kind === "degraded"
  ) {
    return false;
  }
  const resolved = resolveSlackRuntimeIdentity(params);
  if (!resolved) {
    return false;
  }
  applySlackInstallationIdentity(params.ctx, params.installationIdentity);
  params.ctx.botUserId = resolved.botUserId;
  params.ctx.botId = resolved.botId;
  params.ctx.identityHealth = resolveSlackIdentityHealth({
    installationIdentity: params.installationIdentity,
    botUserId: resolved.botUserId,
  });
  return true;
}

export function createSlackIdentityRecovery(params: {
  ctx: SlackMonitorContext;
  accountId: string;
  identity: "bot" | "user";
  token: string;
  clientOptions: WebClientOptions;
  transportApiAppId: string | undefined;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  assertInstallationPolicy: (identity: SlackInstallationIdentity) => void;
  onAdopted: (identity: SlackInstallationIdentity) => Promise<void>;
  publishReadyStatus: () => void;
}) {
  const { ctx, runtime } = params;
  // Recovery auth must not outlive the provider. The startup auth client carries
  // its own request timeout, so only a lifecycle-bound fetch signal cancels an
  // in-flight attempt during teardown.
  const lifecycleAbort = new AbortController();
  const clientOptions = {
    ...params.clientOptions,
    fetch: withSlackLifecycleSignal(
      params.clientOptions.fetch ?? globalThis.fetch,
      lifecycleAbort.signal,
    ),
  };

  let pending: Promise<SlackIdentityRecoveryOutcome> | undefined;
  const recover = async (): Promise<SlackIdentityRecoveryOutcome> => {
    if (ctx.identityHealth.lifecycle !== "blocked") {
      return "not-blocked";
    }
    if (pending) {
      return await pending;
    }
    const recovery = (async (): Promise<SlackIdentityRecoveryOutcome> => {
      try {
        const auth = await createSlackStartupAuthClient(params.token, clientOptions).auth.test();
        const recovered = resolveSlackInstallationIdentity({
          auth,
          transportApiAppId: params.transportApiAppId,
        });
        params.assertInstallationPolicy(recovered);
        const adopted = adoptSlackIdentity({
          ctx,
          identity: params.identity,
          installationIdentity: recovered,
          botUserId: auth.user_id,
          // SAFETY: auth.test omits bot_id for user tokens; the SDK response type does not model it.
          botId: (auth as { bot_id?: string }).bot_id,
        });
        if (!adopted) {
          return "retry";
        }
        runtime.log?.(
          `[${params.accountId}] slack identity recovered; explicit mention detection enabled`,
        );
        await params.onAdopted(recovered);
        return "adopted";
      } catch (err) {
        ctx.identityHealth = { lifecycle: "blocked", lastError: formatUnknownError(err) };
        // Revoked tokens and wrong token types need operator action, and the socket
        // paths already treat them as terminal. Retrying them would issue auth
        // requests for the life of the process.
        return isNonRecoverableSlackAuthError(err) ? "unrecoverable" : "retry";
      }
    })();
    pending = recovery;
    try {
      return await recovery;
    } finally {
      if (pending === recovery) {
        pending = undefined;
      }
    }
  };

  // A transient startup auth.test failure must not disable mention detection for
  // the life of the process: the provider only re-resolves identity on a signed
  // Bolt event or a socket (re)start, so a stable idle connection never retries.
  const runBackoffLoop = async () => {
    for (
      let attempt = 1;
      ctx.identityHealth.lifecycle === "blocked" && !params.abortSignal?.aborted;
      attempt += 1
    ) {
      try {
        await sleepWithAbort(
          computeBackoff(SLACK_IDENTITY_RECOVERY_POLICY, attempt),
          params.abortSignal,
        );
      } catch {
        return;
      }
      const outcome = await recover();
      if (outcome === "unrecoverable") {
        runtime.error?.(
          `[${params.accountId}] slack identity recovery stopped due to non-recoverable auth error; ` +
            "restart with valid credentials to restore explicit mention detection",
        );
        return;
      }
      if (outcome !== "retry") {
        // "adopted" here, or another path adopted first. Publish the ready patch the
        // Bolt-event and socket paths already publish; a stable transport otherwise
        // keeps reporting blocked even though mention detection works again.
        params.publishReadyStatus();
        return;
      }
    }
  };

  return {
    recover,
    startBackoffLoop: () => {
      if (ctx.identityHealth.lifecycle === "blocked") {
        void runBackoffLoop();
      }
    },
    dispose: () => lifecycleAbort.abort(),
  };
}
