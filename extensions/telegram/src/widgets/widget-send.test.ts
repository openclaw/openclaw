import { expect, it, vi } from "vitest";

const { sendWidget, records } = vi.hoisted(() => ({
  sendWidget: vi.fn(),
  records: new Map<string, unknown>(),
}));

// Keep real outbound preparation and the sent-widget store; replace only network and runtime edges.
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  getTelegramRuntime: () => ({
    state: {
      openKeyedStoreV2: () => ({
        register: async (key: string, value: unknown) => {
          records.set(key, value);
        },
        lookup: async (key: string) => records.get(key),
      }),
    },
  }),
}));
vi.mock("../send-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send-context.js")>()),
  withTelegramApiContext: async (
    _opts: unknown,
    operation: (context: unknown) => Promise<unknown>,
  ) =>
    await operation({
      cfg: {},
      account: { accountId: "default", token: "123:abc" },
      api: { raw: { sendWidget } },
    }),
  resolveAndPersistChatId: async () => "111",
}));
vi.mock("../send-outbound.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send-outbound.js")>()),
  finalizeTelegramOutbound: async () => ({ messageId: "42", chatId: "111" }),
}));

const { sendTelegramWidget } = await import("./widget-send.js");
const { lookupTelegramSentWidget } = await import("./widget-store.js");

it("sends a private topic on the Bot API wire and records its message origin", async () => {
  sendWidget.mockResolvedValue({ message_id: 42, chat: { id: 111, type: "private" } });
  await sendTelegramWidget({
    cfg: {},
    accountId: "default",
    to: "111:topic:77",
    source: "<p>Vote</p>",
    title: "Vote",
    name: "vote",
  });
  expect(sendWidget).toHaveBeenCalledWith(
    expect.objectContaining({ chat_id: "111", message_thread_id: 77, html: "<p>Vote</p>" }),
  );
  expect(
    await lookupTelegramSentWidget({ accountId: "default", chatId: "111", messageId: 42 }),
  ).toMatchObject({ name: "vote", messageThreadId: 77 });
});
