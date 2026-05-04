import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ResolvedMaxAccount } from "../types.js";
import { maxMessengerLifecycleAdapter } from "./lifecycle.adapter.js";

/**
 * Phase 1A gateway adapter.
 *
 * Mirrors the shape from
 * `extensions/nextcloud-talk/src/gateway.ts:14` so 1B can swap the body for
 * `runStoppablePassiveMonitor` + `createMaxPollingSupervisor`
 * (docs/max-plugin/plan.md §6.1.3, §6.1.6) without churning the public surface.
 */
export const maxMessengerGatewayAdapter: NonNullable<ChannelPlugin<ResolvedMaxAccount>["gateway"]> =
  {
    startAccount: async (ctx) => {
      await maxMessengerLifecycleAdapter.start(ctx);
    },
    stopAccount: async (ctx) => {
      await maxMessengerLifecycleAdapter.stop(ctx);
    },
  };
