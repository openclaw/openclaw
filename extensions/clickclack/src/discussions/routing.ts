import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { CoreConfig } from "../types.js";
import { hasPendingDiscussionOpenForDestination } from "./binding-generation.js";
import {
  attachBindingToCurrentActiveSession,
  bindingMatchesActiveSessionIncarnation,
  getClickClackDiscussionBindingStore,
  type ClickClackDiscussionBinding,
} from "./binding-store.js";
import { resolveDiscussionBindingAccount } from "./eligibility.js";
import { discussionSessionKey } from "./naming.js";
import { prepareClickClackDiscussionChannelRevocation } from "./revoked-channel-store.js";

type ClickClackDiscussionRoute = {
  agentId: string;
  sessionKey: string;
  systemPrompt: string;
};

type ClickClackDiscussionRouteResolution =
  | { state: "unbound" }
  | { state: "revoked" }
  | { state: "active"; route: ClickClackDiscussionRoute };

export async function resolveClickClackDiscussionRoute(params: {
  runtime: PluginRuntime;
  accountId: string;
  serverBaseUrl: string;
  workspaceId: string;
  channelId: string;
}): Promise<ClickClackDiscussionRouteResolution> {
  const store = getClickClackDiscussionBindingStore(params.runtime);
  await store.prepare();
  let matched = await store.getByChannel(params.serverBaseUrl, params.channelId);
  let pending = false;
  if (!matched) {
    pending = await hasPendingDiscussionOpenForDestination(params);
    matched = await store.getByChannel(params.serverBaseUrl, params.channelId);
  }
  let revocation:
    | Awaited<ReturnType<typeof prepareClickClackDiscussionChannelRevocation>>
    | undefined;
  let bindingFacts: Awaited<ReturnType<typeof store.prepareRead>> | undefined;
  try {
    revocation = await prepareClickClackDiscussionChannelRevocation(params);
    if (revocation.isRevoked(matched?.binding)) {
      return { state: "revoked" };
    }
    if (!matched) {
      return {
        state: pending ? "revoked" : "unbound",
      };
    }
    if (matched.binding.accountId !== params.accountId) {
      return { state: "revoked" };
    }
    if (matched.binding.serverBaseUrl !== params.serverBaseUrl.replace(/\/+$/u, "")) {
      return { state: "revoked" };
    }
    // SAFETY: account resolution only reads the SDK's deep-readonly, schema-validated config.
    const config = params.runtime.config.current() as CoreConfig;
    if (resolveDiscussionBindingAccount(config, matched.binding).state !== "active") {
      return { state: "revoked" };
    }
    bindingFacts = await store.prepareRead(matched.sessionKey);
    let binding: ClickClackDiscussionBinding | undefined;
    try {
      binding = await attachBindingToCurrentActiveSession({
        runtime: params.runtime,
        store,
        sessionKey: matched.sessionKey,
        binding: matched.binding,
      });
    } catch (error) {
      params.runtime.logging
        .getChildLogger({ plugin: "clickclack", feature: "discussions" })
        .warn(
          `discussion attachment refresh failed for channel ${params.channelId}: ${String(error)}`,
        );
      return { state: "revoked" };
    }
    if (!binding) {
      return { state: "revoked" };
    }
    const current = bindingFacts.read();
    if (
      !current ||
      current.externalRef !== binding.externalRef ||
      current.channelId !== binding.channelId ||
      revocation.isRevoked(current) ||
      !bindingMatchesActiveSessionIncarnation(params.runtime, matched.sessionKey, binding) ||
      // SAFETY: This fresh SDK config is schema-validated; account resolution only reads it.
      resolveDiscussionBindingAccount(params.runtime.config.current() as CoreConfig, binding)
        .state !== "active"
    ) {
      return { state: "revoked" };
    }
    const sessionKey = discussionSessionKey({
      runtime: params.runtime,
      agentId: binding.agentId,
      mainSessionKey: matched.sessionKey,
      sessionId: binding.sessionId,
      accountId: params.accountId,
      serverBaseUrl: binding.serverBaseUrl,
      channelId: binding.channelId,
      externalRef: binding.externalRef,
    });
    if (!sessionKey) {
      return { state: "revoked" };
    }
    return {
      state: "active",
      route: {
        agentId: binding.agentId,
        sessionKey,
        systemPrompt: [
          "You are the side agent for a ClickClack discussion attached to an OpenClaw session.",
          `The main session key is ${matched.sessionKey}.`,
          "Observe it with sessions_history and session_status (using changesSince for incremental checks).",
          "Use sessions_send to relay or steer the main session only when the humans in this discussion ask you to.",
          "These session tools are host-scoped to the attached main session; do not attempt session discovery or alternate targets.",
        ].join(" "),
      },
    };
  } catch {
    // Pending or unknown binding settlement cannot authorize a bound message.
    return { state: "revoked" };
  } finally {
    bindingFacts?.release();
    revocation?.release();
  }
}
