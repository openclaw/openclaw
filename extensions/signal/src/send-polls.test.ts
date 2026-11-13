import { beforeEach, expect, it, vi } from "vitest";
import { signalAccountConfig } from "./signal-rpc.test-support.js";

const client = await import("./client-adapter.js");
const signalRpcRequestMock = vi.spyOn(client, "signalRpcRequest");
const { signalPlugin } = await import("./channel.js");
const cfg = signalAccountConfig("external-native", "http://signal.test");
const poll = { question: "Deploy Task B?", options: ["Approve", "Hold", "Cancel"] };

beforeEach(() => {
  signalRpcRequestMock.mockReset().mockResolvedValue({ timestamp: 1700000000123 });
});

it.each([
  ["signal:uuid:e3e7cd8b", { recipient: ["e3e7cd8b"] }],
  ["signal:u:Example.123", { username: ["example.123"] }],
])("sends a multi-answer poll through the outbound adapter to %s", async (to, targetParams) => {
  const result = await signalPlugin.outbound!.sendPoll!({
    cfg,
    to,
    poll: { ...poll, maxSelections: 3 },
  });
  expect(result).toEqual({
    channel: "signal",
    messageId: "1700000000123",
    pollId: "1700000000123",
  });
  expect(signalRpcRequestMock).toHaveBeenCalledWith(
    "sendPollCreate",
    expect.objectContaining({
      question: poll.question,
      option: poll.options,
      ...targetParams,
    }),
    expect.objectContaining({ transportKind: "external-native" }),
  );
  expect(signalRpcRequestMock.mock.calls[0]?.[1]).not.toHaveProperty("no-multi");
});

it("sends a single-answer poll to a group", async () => {
  await signalPlugin.outbound!.sendPoll!({
    cfg,
    to: "group:abc123",
    poll: { ...poll, maxSelections: 1 },
  });
  expect(signalRpcRequestMock.mock.calls[0]?.[1]).toMatchObject({
    "no-multi": true,
    groupId: ["abc123"],
  });
});

it("does not advertise or dispatch polls for the unsupported container transport", async () => {
  const containerCfg = signalAccountConfig("container", "http://signal.test");
  expect(signalPlugin.actions?.describeMessageTool?.({ cfg: containerCfg })?.actions).not.toContain(
    "poll",
  );
  await expect(
    signalPlugin.outbound!.sendPoll!({
      cfg: containerCfg,
      to: "+15550001111",
      poll: { ...poll, maxSelections: 1 },
    }),
  ).rejects.toThrow("require a native signal-cli transport");
  expect(signalRpcRequestMock).not.toHaveBeenCalled();
});
