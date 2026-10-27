import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";

describe("qa channel transport", () => {
  const conversation = { id: "alice", kind: "direct" as const };
  let state: ReturnType<typeof createQaBusState>;
  let transport: ReturnType<typeof createQaChannelTransport>;
  beforeEach(() => {
    state = createQaBusState();
    transport = createQaChannelTransport(state);
  });

  const waitReady = (call: Parameters<typeof transport.waitReady>[0]["gateway"]["call"]) =>
    transport.waitReady({ gateway: { call }, timeoutMs: 5, pollIntervalMs: 1 });
  const addFailure = (text: string) =>
    transport.state.addOutboundMessage({
      accountId: "default",
      to: "dm:qa-operator",
      isError: true,
      text: `⚠️ agent failed before reply: ${text}`,
    });

  it("creates gateway action config for qa-channel", () => {
    expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:43123" })).toEqual({
      channels: {
        "qa-channel": {
          enabled: true,
          baseUrl: "http://127.0.0.1:43123",
          botUserId: "openclaw",
          botDisplayName: "OpenClaw QA",
          allowFrom: ["*"],
          pollTimeoutMs: 250,
        },
      },
      messages: {
        visibleReplies: "automatic",
        groupChat: { mentionPatterns: ["\\b@?openclaw\\b"], visibleReplies: "automatic" },
      },
    });
  });

  it("maps declared transport policy without inspecting scenario ids", () => {
    transport = createQaChannelTransport(state, {
      requireGroupMention: true,
      senderAllowlist: ["driver"],
    });

    expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:43123" })).toMatchObject({
      channels: {
        "qa-channel": {
          allowFrom: ["driver"],
          groupAllowFrom: ["driver"],
          groupPolicy: "allowlist",
          groups: { "*": { requireMention: true } },
        },
      },
    });
  });

  it("builds agent delivery params for qa-channel replies", () => {
    expect(transport.buildAgentDelivery({ target: "dm:qa-operator" })).toEqual({
      channel: "qa-channel",
      replyChannel: "qa-channel",
      replyTo: "dm:qa-operator",
    });
  });

  it("waits until the qa-channel default account is connected and ready", async () => {
    const ready = { accountId: "default", connected: true, lifecycle: "ready", running: true };
    const statuses = [
      { accountId: "default", connected: false, lifecycle: "stopped", running: false },
      { accountId: "default", connected: false, lifecycle: "starting", running: true },
      { accountId: "default", connected: true, lifecycle: "starting", running: true },
      { accountId: "default", connected: true, lifecycle: "blocked", running: true },
      { ...ready, restartPending: true },
      { ...ready, restartPending: false },
    ];
    const call = vi.fn(async () => ({ channelAccounts: { "qa-channel": [statuses.shift()] } }));

    await transport.waitReady({ gateway: { call }, timeoutMs: 2_000, pollIntervalMs: 1 });

    expect(call).toHaveBeenCalledTimes(6);
  });

  it.each([
    {
      account: { accountId: "other", running: true, restartPending: false },
      error: 'qa-channel account "default" not reported; available accounts: other',
    },
    {
      account: { accountId: "default", running: false, restartPending: true },
      error:
        'timed out after 5ms waiting for qa-channel ready; last status: {"accountId":"default","running":false,"connected":null,"lifecycle":null,"restartPending":true,"lastError":null}',
    },
    { account: null, error: "last check error: channels.status exploded" },
  ])("reports readiness failure: $error", async ({ account, error }) => {
    const call = account
      ? vi.fn().mockResolvedValue({ channelAccounts: { "qa-channel": [account] } })
      : vi.fn().mockRejectedValue(new Error("channels.status exploded"));
    await expect(waitReady(call)).rejects.toThrow(error);
  });

  it("implements the portable scenario transport actions", async () => {
    await transport.sendInbound({ conversation, senderId: "alice", text: "hello" });
    await transport.state.addOutboundMessage({ to: "dm:alice", text: "QA-PORTABLE-OK" });

    await expect(
      transport.waitForOutbound({ conversation, textIncludes: "QA-PORTABLE-OK" }),
    ).resolves.toMatchObject({ text: "QA-PORTABLE-OK" });
    // The synthetic fixture has no channel poller; record its completed turn.
    state.resolvePollCursor({ acknowledgedCursor: state.getSnapshot().cursor });
    await transport.reset();
    expect(transport.state.getSnapshot().messages).toEqual([]);
  });

  it("keeps outbound verdicts bound to the selected account", async () => {
    const foreign = { accountId: "other", to: "dm:alice" };
    state.addOutboundMessage({ ...foreign, text: "QA-ACCOUNT-OK" });
    state.addOutboundMessage({
      ...foreign,
      isError: true,
      text: "⚠️ agent failed before reply: foreign account failure",
    });
    const expected = state.addOutboundMessage({
      accountId: "default",
      to: "dm:alice",
      text: "QA-ACCOUNT-OK",
    });

    await expect(
      transport.waitForOutbound({ conversation, textIncludes: "QA-ACCOUNT-OK", timeoutMs: 50 }),
    ).resolves.toMatchObject({ accountId: "default", id: expected.id });
  });

  it("injects /queue with its complete command and token-only metadata", async () => {
    const command = "queue collect please help";
    await transport.sendNativeCommand({ command, conversation, senderId: "alice" });

    const [message] = transport.state.getSnapshot().messages;
    expect(message).toMatchObject({
      text: `/${command}`,
      nativeCommand: { name: "queue" },
    });
  });

  it("inherits the shared failure-aware wait helper", async () => {
    const check = vi.fn<() => Promise<undefined>>().mockResolvedValue(undefined);
    check.mockImplementationOnce(async () => {
      await addFailure("synthetic failure for wait helper");
      return undefined;
    });
    await expect(transport.waitForCondition(check, 50, 10)).rejects.toThrow(
      "synthetic failure for wait helper",
    );
  });

  it("captures a fresh failure cursor for each wait helper call", async () => {
    await addFailure("stale failure should not leak");

    await expect(transport.waitForCondition(async () => "ok", 50, 10)).resolves.toBe("ok");
  });

  it("keeps oversized wait helper intervals within the timeout", async () => {
    await expect(
      transport.waitForCondition(async () => undefined, 5, Number.MAX_SAFE_INTEGER),
    ).rejects.toThrow("timed out after 5ms");
  });
});
