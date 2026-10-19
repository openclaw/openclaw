import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
  type PluginRuntime,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-chunking";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { matrixPlugin } from "../../channel.js";
import { setMatrixRuntime } from "../../runtime.js";
import type { CoreConfig } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { sendMessageMatrix } from "../send.js";
import { deliverMatrixReplies } from "./replies.js";

const table = "| Name | Status |\n|---|---|\n| Alpha | Ready |";
type Delivery = Parameters<typeof deliverMatrixReplies>[0];
const firstReply = () => ({
  replyToMode: "first" as const,
  replyToId: "$incoming",
  hasRepliedRef: { value: false },
});
function createClient(options: { cfg?: CoreConfig; accountId?: string } = {}) {
  let nextId = 0;
  const sendMessage = vi.fn(
    async (_roomId: string, _content: Record<string, unknown>) => `$sent-${++nextId}`,
  );
  const client = {
    prepareRoomForMessageSend: async () => "m.room.message",
    getUserId: async () => "@bot:example.org",
    getJoinedRoomMembers: async () => [],
    sendMessage,
  } as unknown as MatrixClient;
  const params = {
    cfg: { channels: { matrix: {} } },
    roomId: "!room:example.org",
    runtime: {} as RuntimeEnv,
    replyToMode: "off" as const,
    ...options,
    client,
  };
  return {
    sendMessage,
    contents: () => sendMessage.mock.calls.map(([, content]) => content),
    direct: (text: string) => sendMessageMatrix(params.roomId, text, params),
    reply: (reply: Delivery["replies"][number], overrides: Partial<Delivery> = {}) =>
      deliverMatrixReplies({ ...params, replies: [reply], ...overrides }),
  };
}

async function compareDirect(text: string, options: Parameters<typeof createClient>[0]) {
  const direct = createClient(options);
  const automatic = createClient(options);
  await direct.direct(text);
  const result = await automatic.reply({ text });
  expect(automatic.contents()).toEqual(direct.contents());
  return { ...automatic, result };
}

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "matrix", source: "test", plugin: matrixPlugin }]),
  );
  setMatrixRuntime({
    channel: {
      text: {
        resolveMarkdownTableMode,
        resolveTextChunkLimit,
        resolveChunkMode,
        chunkMarkdownTextWithMode,
      },
    },
    logging: { shouldLogVerbose: () => false },
  } as unknown as PluginRuntime);
});

afterEach(resetPluginRuntimeStateForTest);

it("uses the same native output for automatic and direct sends with disabled table parsing", async () => {
  const cfg: CoreConfig = { channels: { matrix: { markdown: { tables: "off" } } } };
  const { contents, sendMessage, result } = await compareDirect(table, { cfg });
  expect(result.visibleReplySent).toBe(true);
  expect(sendMessage).toHaveBeenCalledOnce();
  expect(contents()[0]?.formatted_body).toContain("| Name | Status |");
});

it("keeps a native table within a long automatic reply while preserving code examples", async () => {
  const text = `${"Paragraph content. ".repeat(250)}\n\n${table}\n\n\`\`\`md\n${table}\n\`\`\`\n\n    indented code`;
  const automatic = createClient();
  const result = await automatic.reply({ text });
  const contents = automatic.contents();
  expect(result.visibleReplySent).toBe(true);
  expect(contents.length).toBeGreaterThan(1);
  expect(contents.every((content) => String(content.body).length <= 4000)).toBe(true);
  const html = contents.map((content) => content.formatted_body).join("\n");
  expect(html).toContain("<table>");
  expect(html).toContain('<pre><code class="language-md">');
  expect(html).toContain("<pre><code>indented code");
});

it("keeps first-reply relations and receipts across separate dispatches", async () => {
  const { reply, sendMessage } = createClient();
  const delivery = firstReply();
  const { hasRepliedRef } = delivery;
  const first = await reply({ text: "Visible paragraph. ".repeat(400) }, delivery);
  const firstCount = sendMessage.mock.calls.length;
  expect(firstCount).toBeGreaterThan(1);
  expect(first).toMatchObject({
    messageIds: sendMessage.mock.calls.map((_, index) => `$sent-${index + 1}`),
    receipt: { primaryPlatformMessageId: "$sent-1" },
    content: sendMessage.mock.calls.map(([, content]) => content.body).join("\n"),
  });
  expect(hasRepliedRef.value).toBe(true);
  for (const [, content] of sendMessage.mock.calls.slice(0, firstCount)) {
    expect(content["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$incoming" } });
  }
  await reply({ text: "Next payload" }, delivery);
  expect(sendMessage).toHaveBeenCalledTimes(firstCount + 1);
  expect(sendMessage.mock.calls[firstCount]?.[1].body).toBe("Next payload");
  expect(sendMessage.mock.calls[firstCount]?.[1]["m.relates_to"]).toBeUndefined();
});

it.each([
  { name: "thread fallback", thread: true, explicit: false },
  { name: "selected thread reply", thread: true, explicit: true },
  { name: "selected unthreaded reply", thread: false, explicit: true },
])("encodes $name in the actual provider relation", async ({ thread, explicit }) => {
  const { reply, sendMessage } = createClient();
  const selected = thread ? "$selected" : "$chosen";
  const result = await reply(
    {
      text: thread ? "Thread paragraph. ".repeat(400) : "hello",
      ...(explicit ? { replyToId: selected, replyToTag: true } : {}),
    },
    {
      threadId: thread ? "$thread" : undefined,
      replyToId: thread ? "$incoming" : "$ambient",
    },
  );
  expect(result.visibleReplySent).toBe(true);
  if (thread) {
    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
  } else {
    expect(sendMessage).toHaveBeenCalledOnce();
  }
  for (const [, content] of sendMessage.mock.calls) {
    expect(content["m.relates_to"]).toEqual({
      ...(thread ? { rel_type: "m.thread", event_id: "$thread" } : {}),
      ...(explicit ? {} : { is_falling_back: true }),
      "m.in_reply_to": { event_id: explicit ? selected : "$incoming" },
    });
  }
  expect(
    result.receipt?.parts.every((part) => part.replyToId === (explicit ? selected : undefined)),
  ).toBe(true);
});

it("uses the account limit and canonical bullet fallback for an oversized native table", async () => {
  const rows = Array.from({ length: 40 }, (_, index) => `| Item${index} | Ready${index} |`);
  const text = `| Name | Status |\n|---|---|\n${rows.join("\n")}`;
  const cfg = {
    channels: {
      matrix: { accounts: { ops: { textChunkLimit: 256, streaming: { chunkMode: "newline" } } } },
    },
  } as CoreConfig;
  const { contents } = await compareDirect(text, { cfg, accountId: "ops" });
  const bodies = contents();
  expect(bodies.length).toBeGreaterThan(1);
  expect(bodies.every((content) => String(content.body).length <= 256)).toBe(true);
  const visible = bodies.map((content) => content.body).join("\n");
  for (let index = 0; index < rows.length; index++) {
    expect(visible).toContain(`Item${index}`);
    expect(visible).toContain(`Ready${index}`);
  }
  expect(bodies.map((content) => content.formatted_body).join("\n")).toContain(
    "<strong>Item0</strong>",
  );
});

it("retains the accepted event and first-reply slot when a later chunk fails", async () => {
  const { reply, sendMessage } = createClient();
  sendMessage.mockImplementation(async () => {
    if (sendMessage.mock.calls.length === 2) {
      throw new Error("second wire event failed");
    }
    return "$accepted";
  });
  const delivery = firstReply();
  const { hasRepliedRef } = delivery;
  const error = await reply({ text: "Visible paragraph. ".repeat(400) }, delivery).catch(
    (caught: unknown) => caught,
  );
  expect(sendMessage).toHaveBeenCalledTimes(2);
  expect(hasRepliedRef.value).toBe(true);
  expect(error).toMatchObject({
    code: "CHANNEL_PARTIAL_DELIVERY",
    deliveryResult: {
      messageIds: ["$accepted"],
      visibleReplySent: true,
      content: sendMessage.mock.calls[0]?.[1].body,
      receipt: { parts: [expect.objectContaining({ replyToId: "$incoming" })] },
    },
  });
});
