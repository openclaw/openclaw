import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { describe, expect, it } from "vitest";
import {
  resolveDiscordNativeBindingTarget,
  resolveDiscordNativeBoundRoute,
} from "./native-command-route.js";

const baseRoute: ResolvedAgentRoute = {
  agentId: "main",
  channel: "discord",
  accountId: "default",
  sessionKey: "agent:main:discord:direct:owner",
  mainSessionKey: "agent:main:primary",
  lastRoutePolicy: "session",
  matchedBy: "default",
};

describe("Discord native command bound routes", () => {
  it("prefers the thread binding's explicit agent for opaque session keys", () => {
    const target = resolveDiscordNativeBindingTarget({
      threadBinding: {
        targetSessionKey: "plugin-binding:openclaw-codex-app-server:thread",
        agentId: "codex",
      } as never,
      configuredBinding: {
        statefulTarget: {
          sessionKey: "plugin-binding:configured:dm",
          agentId: "configured-agent",
        },
      } as never,
    });

    expect(target).toEqual({
      agentId: "codex",
      sessionKey: "plugin-binding:openclaw-codex-app-server:thread",
    });
    expect(
      resolveDiscordNativeBoundRoute({
        cfg: { session: { mainKey: "primary" } } as OpenClawConfig,
        effectiveRoute: baseRoute,
        bindingTarget: target,
      }),
    ).toEqual({
      ...baseRoute,
      agentId: "codex",
      sessionKey: "plugin-binding:openclaw-codex-app-server:thread",
      mainSessionKey: "agent:codex:primary",
      lastRoutePolicy: "session",
    });
  });

  it("uses the configured binding's explicit agent for opaque session keys", () => {
    const target = resolveDiscordNativeBindingTarget({
      configuredBinding: {
        statefulTarget: {
          sessionKey: "plugin-binding:openclaw-codex-app-server:dm",
          agentId: "codex",
        },
      } as never,
    });

    expect(target).toEqual({
      agentId: "codex",
      sessionKey: "plugin-binding:openclaw-codex-app-server:dm",
    });
  });
});
