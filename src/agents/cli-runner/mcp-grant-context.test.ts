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
  it("snapshots policy and logical model fields without copying private metadata", () => {
    const elevated = {
      enabled: false,
      allowed: false,
      defaultLevel: "off" as const,
      fullAccessAvailable: false,
      privateMetadata: "must not enter the grant",
    };
    const selected = { provider: "selected-provider", model: "selected-provider/literal-model" };
    const requesterModel = { ...selected, nativeModelId: "native-model[1m]" };
    const gatewayUiCommandTarget = { connId: "requester-tab", profileId: "requester" };
    const grant = buildGrant({ bashElevated: elevated, requesterModel, gatewayUiCommandTarget });
    elevated.enabled = true;
    requesterModel.model = "later-model";
    expect(grant.requesterModel).toEqual(selected);
    expect(grant.gatewayUiCommandTarget).toEqual(gatewayUiCommandTarget);
    expect(grant.bashElevated).toEqual({
      enabled: false,
      allowed: false,
      defaultLevel: "off",
      fullAccessAvailable: false,
    });
    expect(
      buildGrant({ bashElevated: { ...elevated, fullAccessAvailable: undefined } }).bashElevated,
    ).not.toHaveProperty("fullAccessAvailable");
  });

  it.each([
    ["read-only", undefined, "read-only"],
    ["workspace", "full", "full"],
    ["full", "allowlist", "guarded"],
  ] as const)(
    "maps persisted %s with execution override %s to %s permission",
    (persisted, mode, permissionMode) => {
      const grant = buildGrant({
        sessionEntry: { ...session, permissionMode: persisted, execHost: "gateway" },
        execOverrides: mode ? { mode } : undefined,
      });
      expect(grant.execSession).toMatchObject({ permissionMode, execHost: "gateway" });
      expect(grant.execOverrides).toEqual(mode ? { mode } : undefined);
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
    const grant = buildGrant(overrides);
    expect(grant.sourceReplyOnly).toBeUndefined();
    expect(grant).not.toHaveProperty("inputProvenance");
  });
  it.each(["report_only", "host_only"] as const)("retains %s in the minted grant", (capability) => {
    expect(buildGrant({}, capability)).toMatchObject({ delegationCapability: capability });
  });

  it("carries policy-neutral internal provenance for plugin tools", () => {
    const inputProvenance = {
      kind: "internal_system",
      sourceTool: "exec",
      runId: "owner-run",
    } as const;
    expect(buildGrant({ inputProvenance }).inputProvenance).toEqual(inputProvenance);
  });

  it("leaves the grant shape untouched for ordinary runs", () => {
    const grant = buildGrant();
    for (const field of ["delegationCapability", "bashElevated", "requesterModel"]) {
      expect(grant).not.toHaveProperty(field);
    }
    expect(buildGrant({}, "full")).not.toHaveProperty("delegationCapability");
  });
});
