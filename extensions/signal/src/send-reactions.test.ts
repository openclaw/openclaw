import { beforeAll, beforeEach, expect, it, vi } from "vitest";

const rpcMock = vi.fn();

// mock-isolation: fixed account routing avoids reading operator Signal configuration.
vi.mock("./accounts.js", () => ({
  resolveSignalAccount: () => ({
    baseUrl: "http://signal.local",
    transport: { kind: "managed-native" },
    config: { account: "+15550001111" },
  }),
}));

vi.mock("./client-adapter.js", () => ({
  signalRpcRequest: (...args: unknown[]) => rpcMock(...args),
}));

let sendReactionSignal: typeof import("./send-reactions.js").sendReactionSignal;
let removeReactionSignal: typeof import("./send-reactions.js").removeReactionSignal;

const SIGNAL_TEST_CFG = { channels: { signal: { accounts: { default: {} } } } };
const uuid = "123E4567-E89B-12D3-A456-426614174000";

function expectRpc(params: Record<string, unknown>) {
  const expected = { emoji: "✅", targetTimestamp: 123, account: "+15550001111", ...params };
  expect(rpcMock.mock.calls[0]?.[1]).toStrictEqual(expected);
  expect(rpcMock).toHaveBeenCalledWith("sendReaction", expected, {
    baseUrl: "http://signal.local",
    timeoutMs: undefined,
    transportKind: "managed-native",
  });
}

beforeAll(async () => {
  ({ sendReactionSignal, removeReactionSignal } = await import("./send-reactions.js"));
});

beforeEach(() => {
  rpcMock.mockClear().mockResolvedValue({ timestamp: 123 });
});

it.each([
  ["mixed-case Signal and UUID prefixes", `  SiGnAl:  UuId:${uuid}  `, uuid],
  ["Signal-prefixed phone number", " SiGnAl: +15551230000 ", "+15551230000"],
])("uses recipients and targetAuthor for %s DMs", async (_name, recipient, expectedRecipient) => {
  await sendReactionSignal(recipient, 123, "✅", { cfg: SIGNAL_TEST_CFG });
  expectRpc({
    targetAuthor: expectedRecipient,
    recipients: [expectedRecipient],
  });
});

it("uses groupIds array and maps targetAuthorUuid", async () => {
  await sendReactionSignal("", 123, "✅", {
    cfg: SIGNAL_TEST_CFG,
    groupId: "group-id",
    targetAuthorUuid: ` SiGnAl: UuId:${uuid} `,
  });
  expectRpc({
    groupIds: ["group-id"],
    targetAuthor: uuid,
  });
});

it("honors an explicit container endpoint override", async () => {
  await sendReactionSignal("+15551230000", 123, "✅", {
    cfg: SIGNAL_TEST_CFG,
    baseUrl: "http://container:8080",
    transportKind: "container",
  });

  expect(rpcMock).toHaveBeenCalledWith(
    "sendReaction",
    expect.any(Object),
    expect.objectContaining({
      baseUrl: "http://container:8080",
      transportKind: "container",
    }),
  );
});

it("defaults targetAuthor to recipient for removals", async () => {
  await removeReactionSignal("+15551230000", 456, "❌", { cfg: SIGNAL_TEST_CFG });
  expectRpc({
    emoji: "❌",
    targetTimestamp: 456,
    recipients: ["+15551230000"],
    targetAuthor: "+15551230000",
    remove: true,
  });
});
