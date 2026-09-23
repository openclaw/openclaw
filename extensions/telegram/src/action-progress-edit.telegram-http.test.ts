import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import type { ChannelProgressDraftCompositorSnapshot } from "openclaw/plugin-sdk/channel-outbound";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, beforeAll, expect, it } from "vitest";
import { telegramPlugin } from "./channel.js";
import { resetTelegramClientOptionsCacheForTests } from "./send.js";

let server: Server;
let apiRoot: string;
const sockets = new Set<Socket>();
const requests: Array<{ method: string; fields: Record<string, unknown> }> = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({
        method: request.url?.split("/").at(-1) ?? "",
        fields: body,
      });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 42,
            date: 1_700_000_000,
            chat: { id: 123, type: "private" },
            text: body.text,
          },
        }),
      );
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the test HTTP listener");
  }
  apiRoot = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  resetTelegramClientOptionsCacheForTests();
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

it.each([
  { kind: "text", revoke: false },
  { kind: "text", revoke: true },
  { kind: "markup", revoke: true },
])("retains live authority for $kind edits (revoked: $revoke)", async ({ kind, revoke }) => {
  await withOpenClawTestState({ prefix: "telegram-progress-edit-" }, async () => {
    resetTelegramClientOptionsCacheForTests();
    requests.length = 0;
    let current = true;
    const result = Promise.resolve(
      telegramPlugin.actions?.handleAction?.({
        channel: "telegram",
        action: "edit",
        cfg: { channels: { telegram: { botToken: `123456:edit-${kind}-${revoke}`, apiRoot } } },
        params: {
          to: "123",
          messageId: "42",
          ...(kind === "text"
            ? { message: "Progress after yield." }
            : {
                presentation: {
                  blocks: [
                    {
                      type: "buttons",
                      buttons: [
                        { label: "Continue", action: { type: "callback", value: "continue" } },
                      ],
                    },
                  ],
                },
              }),
        },
        conversationReadOrigin: "direct-operator",
        assertDirectAdapterHandoff: () => {
          if (!current) {
            throw new Error("Progress owner retired");
          }
        },
      }),
    );
    if (revoke) {
      current = false;
      await expect(result).rejects.toThrow("Progress owner retired");
      expect(requests).toEqual([]);
    } else {
      await result;
      expect(requests).toEqual([
        {
          method: "editMessageText",
          fields: expect.objectContaining({ message_id: 42, text: "Progress after yield." }),
        },
      ]);
    }
  });
});

it.each([false, true])(
  "edits an adopted snapshot with the native checklist and command layout (rich: %s)",
  async (richMessages) => {
    await withOpenClawTestState({ prefix: "telegram-progress-native-edit-" }, async () => {
      resetTelegramClientOptionsCacheForTests();
      requests.length = 0;
      const command = "printf '<ready>&' && ./verify --flag=\"<value>\"";
      const progressSnapshot: ChannelProgressDraftCompositorSnapshot = {
        label: "Working",
        statusHeadline: command,
        statusHeadlineFormat: "plain",
        lines: ["Older activity must not displace the adopted checklist"],
        plan: [
          { step: "Inspect <source> & config", status: "completed" },
          { step: "Verify the result", status: "in_progress" },
        ],
      };
      await telegramPlugin.actions?.handleAction?.({
        channel: "telegram",
        action: "edit",
        accountId: "worker",
        cfg: {
          channels: {
            telegram: {
              botToken: `123456:progress-native-${richMessages}`,
              apiRoot,
              richMessages: !richMessages,
              streaming: { progress: { maxLines: 1, maxLineChars: 8 } },
              accounts: {
                worker: {
                  richMessages,
                  streaming: {
                    mode: "progress",
                    progress: { toolProgress: true, maxLines: 2, maxLineChars: 120 },
                  },
                },
              },
            },
          },
        },
        params: {
          to: "123",
          messageId: "42",
          message: "Generic fallback must not replace the native card.",
        },
        progressSnapshot,
        conversationReadOrigin: "direct-operator",
      });

      expect(requests).toEqual([
        {
          method: "editMessageText",
          fields: expect.objectContaining({
            chat_id: "123",
            message_id: 42,
          }),
        },
      ]);
      const fields = requests[0]!.fields;
      if (richMessages) {
        expect(fields.text).toBeUndefined();
        expect(fields.parse_mode).toBeUndefined();
        expect(fields.rich_message).toMatchObject({
          skip_entity_detection: true,
          blocks: [
            { type: "paragraph", text: { type: "bold", text: "Working" } },
            { type: "paragraph", text: { type: "code", text: command } },
            {
              type: "list",
              items: [
                {
                  has_checkbox: true,
                  is_checked: true,
                  blocks: [{ type: "paragraph", text: "Inspect <source> & config" }],
                },
                {
                  has_checkbox: true,
                  blocks: [
                    {
                      type: "paragraph",
                      text: { type: "bold", text: "Verify the result (in progress)" },
                    },
                  ],
                },
              ],
            },
          ],
        });
      } else {
        expect(fields.rich_message).toBeUndefined();
        expect(fields.parse_mode).toBe("HTML");
        expect(fields.text).toContain(
          "<code>printf '&lt;ready&gt;&amp;' &amp;&amp; ./verify --flag=\"&lt;value&gt;\"</code>",
        );
        expect(fields.text).toContain("[x] Inspect &lt;source&gt; &amp; config");
        expect(fields.text).toContain("[ ] <b>Verify the result (in progress)</b>");
        expect(fields.text).not.toContain("&amp;lt;");
      }
    });
  },
);
