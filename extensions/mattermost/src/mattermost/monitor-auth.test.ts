import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setMattermostRuntime } from "../runtime.js";

const isDangerousNameMatchingEnabled = vi.hoisted(() => vi.fn());
const resolveAllowlistMatchSimple = vi.hoisted(() => vi.fn());

vi.mock("./runtime-api.js", () => ({
  isDangerousNameMatchingEnabled,
  resolveAllowlistMatchSimple,
}));

describe("mattermost monitor auth", () => {
  let auth: typeof import("./monitor-auth.js");
  let normalizeMattermostAllowEntry: typeof import("./ingress-identity.js").normalizeMattermostAllowEntry;

  beforeAll(async () => {
    auth = await import("./monitor-auth.js");
    ({ normalizeMattermostAllowEntry } = await import("./ingress-identity.js"));
  });

  beforeEach(() => {
    setMattermostRuntime(createPluginRuntimeMock());
    isDangerousNameMatchingEnabled.mockReset();
    resolveAllowlistMatchSimple.mockReset();
  });

  const direct = {
    channelInfo: { type: "D", name: "alice", display_name: "Alice" },
    kind: "direct",
    chatType: "direct",
    channelName: "alice",
    channelDisplay: "Alice",
    roomLabel: "#alice",
  };
  const denied = { ok: false, commandAuthorized: false };
  function authorize(
    config: Parameters<typeof auth.authorizeMattermostCommandInvocation>[0]["account"]["config"],
    allowTextCommands: boolean,
    hasControlCommand: boolean,
    channelInfo = direct.channelInfo,
  ) {
    return auth.authorizeMattermostCommandInvocation({
      account: { config } as never,
      cfg: {},
      senderId: "alice",
      senderName: "Alice",
      channelId: channelInfo.type === "D" ? "dm-1" : "chan-1",
      channelInfo: channelInfo as never,
      allowTextCommands,
      hasControlCommand,
    });
  }

  it("normalizes allowlist entries", () => {
    expect(normalizeMattermostAllowEntry(" @Alice ")).toBe("alice");
    expect(normalizeMattermostAllowEntry("mattermost:Bob")).toBe("bob");
    expect(normalizeMattermostAllowEntry("accessGroup:Ops")).toBe("accessGroup:Ops");
    expect(normalizeMattermostAllowEntry("*")).toBe("*");
    expect(auth.normalizeMattermostAllowList([" Alice ", "user:alice", "ALICE", "*"])).toEqual([
      "alice",
      "*",
    ]);
  });

  it("checks sender allowlists against normalized ids and names", () => {
    resolveAllowlistMatchSimple.mockReturnValue({ allowed: true });
    expect(
      auth.isMattermostSenderAllowed({
        senderId: "@Alice",
        senderName: "Alice",
        allowFrom: [" mattermost:alice "],
        allowNameMatching: true,
      }),
    ).toBe(true);
    expect(resolveAllowlistMatchSimple).toHaveBeenCalledWith({
      allowFrom: ["alice"],
      senderId: "alice",
      senderName: "alice",
      allowNameMatching: true,
    });
  });

  it("formats direct-message drops with the ingress reason and open-policy hint", () => {
    expect(
      auth.formatMattermostDirectMessageDropLog({
        senderId: "alice-id",
        dmPolicy: "open",
        reasonCode: "dm_policy_not_allowlisted",
      }),
    ).toBe(
      "mattermost: drop dm sender=alice-id (dmPolicy=open reason=dm_policy_not_allowlisted hint=add-allowFrom-wildcard)",
    );
  });

  it("resolves direct command authorization from shared ingress", async () => {
    isDangerousNameMatchingEnabled.mockReturnValue(false);
    resolveAllowlistMatchSimple.mockReturnValue({ allowed: false });

    await expect(authorize({ dmPolicy: "open" }, true, true)).resolves.toEqual({
      ...direct,
      ...denied,
      denyReason: "unauthorized",
    });

    resolveAllowlistMatchSimple.mockReturnValue({ allowed: true });

    await expect(authorize({ dmPolicy: "open", allowFrom: ["*"] }, false, false)).resolves.toEqual({
      ...direct,
      ok: true,
      commandAuthorized: true,
    });

    await expect(authorize({ dmPolicy: "disabled" }, false, false)).resolves.toEqual({
      ...direct,
      ...denied,
      denyReason: "dm-disabled",
    });

    await expect(
      authorize({ groupPolicy: "allowlist" }, true, false, {
        type: "O",
        name: "town-square",
        display_name: "Town Square",
      }),
    ).resolves.toEqual({
      ...denied,
      denyReason: "channel-no-allowlist",
      channelInfo: { type: "O", name: "town-square", display_name: "Town Square" },
      kind: "channel",
      chatType: "channel",
      channelName: "town-square",
      channelDisplay: "Town Square",
      roomLabel: "#town-square",
    });
  });
});
