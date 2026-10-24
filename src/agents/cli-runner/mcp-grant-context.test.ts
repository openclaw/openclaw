import { describe, expect, it } from "vitest";
import {
  buildCliMcpDelegationCapabilityBinding,
  buildCliMcpGrantContext,
} from "./mcp-grant-context.js";
import type { RunCliAgentParams } from "./types.js";

const session = { sessionId: "cli-session", updatedAt: 1 };
function buildGrant(
  overrides: Partial<RunCliAgentParams> = {},
  delegationCapability?: "full" | "host_only" | "report_only",
) {
  const run = {
    sessionKey: "agent:main:telegram:group:chat123",
    workspaceDir: "/workspace",
    inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
    sourceReplyDeliveryMode: "message_tool_only",
    messageProvider: "telegram",
    currentChannelId: "telegram:chat123",
    cliToolAvailability: { native: [], openClaw: ["message"] },
    ...overrides,
    ...(delegationCapability ? buildCliMcpDelegationCapabilityBinding(delegationCapability) : {}),
  } as RunCliAgentParams;

  return buildCliMcpGrantContext({
    run,
    config: {},
    requireExplicitMessageTarget: false,
    agentId: "main",
    modelProvider: "openai",
    modelId: "gpt-5.6-luna",
  });
}

describe("buildCliMcpGrantContext", () => {
  it("snapshots only elevated policy fields and preserves false availability", () => {
    const elevated = {
      enabled: false,
      allowed: false,
      defaultLevel: "off" as const,
      fullAccessAvailable: false,
      privateMetadata: "must not enter the grant",
    };
    const grant = buildGrant({ bashElevated: elevated });
    elevated.enabled = true;
    expect(grant.bashElevated).toEqual({
      enabled: false,
      allowed: false,
      defaultLevel: "off",
      fullAccessAvailable: false,
    });
    expect(buildGrant()).not.toHaveProperty("bashElevated");
    expect(
      buildGrant({ bashElevated: { ...elevated, fullAccessAvailable: undefined } }).bashElevated,
    ).not.toHaveProperty("fullAccessAvailable");
  });

  it("snapshots only the resolved logical model into the loopback grant", () => {
    const selected = {
      provider: "selected-provider",
      model: "selected-provider/literal-model",
    };
    const requesterModel = { ...selected, nativeModelId: "native-model[1m]" };
    const grant = buildGrant({ requesterModel });
    requesterModel.model = "later-model";

    expect(grant.requesterModel).toEqual(selected);
    expect(buildGrant()).not.toHaveProperty("requesterModel");
  });

  it("binds screen commands to the requesting browser in the server-owned grant", () => {
    const gatewayUiCommandTarget = { connId: "requester-tab", profileId: "requester" };
    expect(buildGrant({ gatewayUiCommandTarget }).gatewayUiCommandTarget).toEqual(
      gatewayUiCommandTarget,
    );
  });

  it("carries the exact read-only session permission into the loopback grant", () => {
    const permission = { permissionMode: "read-only", execHost: "gateway" } as const;
    expect(buildGrant({ sessionEntry: { ...session, ...permission } })).toMatchObject({
      execSession: permission,
    });
  });

  it.each([
    ["workspace", "full", "full"],
    ["full", "allowlist", "guarded"],
  ] as const)(
    "maps persisted %s with execution override %s to %s permission",
    (persisted, mode, permissionMode) => {
      const grant = buildGrant({
        sessionEntry: { ...session, permissionMode: persisted },
        execOverrides: { mode },
      });
      expect(grant).toMatchObject({ execSession: { permissionMode }, execOverrides: { mode } });
    },
  );

  it.each([
    { label: "the provider", overrides: { messageProvider: undefined } },
    { label: "the destination", overrides: { currentChannelId: undefined } },
  ])("keeps completion authority restricted when $label is missing", ({ overrides }) => {
    expect(buildGrant(overrides).sourceReplyOnly).toBe(true);
  });

  it.each<Partial<RunCliAgentParams>>([
    { inputProvenance: { kind: "external_user" } },
    { inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" } },
    { sourceReplyDeliveryMode: "automatic" },
    { cliToolAvailability: undefined },
    { cliToolAvailability: { native: [], openClaw: ["message", "read"] } },
  ])("does not stamp source-only authority for %j", (overrides) => {
    expect(buildGrant(overrides).sourceReplyOnly).toBeUndefined();
  });
  it.each(["report_only", "host_only"] as const)("retains %s in the minted grant", (capability) => {
    expect(buildGrant({}, capability)).toMatchObject({ delegationCapability: capability });
  });

  it.each([
    [{ kind: "internal_system", sourceTool: "exec", runId: "owner-run" }, true],
    [{ kind: "external_user" }, false],
    [{ kind: "inter_session", sourceTool: "sessions_send" }, false],
  ] as const)(
    "carries policy-neutral internal provenance %j for plugin tools",
    (input, carried) => {
      const grant = buildGrant({ inputProvenance: input });
      if (carried) {
        expect(grant.inputProvenance).toEqual(input);
      } else {
        expect(grant).not.toHaveProperty("inputProvenance");
      }
    },
  );

  it("leaves the grant shape untouched for ordinary runs", () => {
    // Full authority must not add a key to ordinary grant contexts.
    expect(buildGrant()).not.toHaveProperty("delegationCapability");
    expect(buildGrant({}, "full")).not.toHaveProperty("delegationCapability");
  });
});
