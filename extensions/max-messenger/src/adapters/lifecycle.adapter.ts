import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { ResolvedMaxAccount } from "../types.js";

/**
 * Phase 1A lifecycle stub.
 *
 * `start(ctx)` logs that scaffolding came up and returns immediately. The real
 * polling supervisor (`createMaxPollingSupervisor` per
 * docs/max-plugin/plan.md §6.1.6) replaces the body in Phase 1B; the gateway
 * adapter is wired now so the lifecycle plumbing can land first.
 *
 * `stop(ctx)` is a no-op until 1B owns a long-running loop — included here so
 * the gateway adapter has a symmetric symbol to call.
 */
export const maxMessengerLifecycleAdapter = {
  start(ctx: ChannelGatewayContext<ResolvedMaxAccount>): Promise<void> {
    ctx.log?.info?.(
      `[max-messenger:${ctx.account.accountId}] MAX Messenger channel started ` +
        "(Phase 1A scaffolding, polling disabled)",
    );
    return Promise.resolve();
  },
  stop(ctx: ChannelGatewayContext<ResolvedMaxAccount>): Promise<void> {
    ctx.log?.info?.(
      `[max-messenger:${ctx.account.accountId}] MAX Messenger channel stopped ` +
        "(Phase 1A scaffolding)",
    );
    return Promise.resolve();
  },
};
