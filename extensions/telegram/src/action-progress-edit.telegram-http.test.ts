import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelProgressDraftCompositorSnapshot } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { telegramPlugin } from "./channel.js";
import { resetTelegramClientOptionsCacheForTests } from "./send.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";

const fixture = useTelegramHttpFixture();
const { requests } = fixture;
const withEditState = (run: () => Promise<void>) =>
  withOpenClawTestState({ prefix: "telegram-progress-edit-" }, async () => {
    resetTelegramClientOptionsCacheForTests();
    requests.length = 0;
    await run();
  });
const edit = (
  params: Record<string, unknown>,
  telegram: NonNullable<OpenClawConfig["channels"]>["telegram"],
  context: Partial<ChannelMessageActionContext> = {},
) =>
  telegramPlugin.actions?.handleAction?.({
    channel: "telegram",
    action: "edit",
    conversationReadOrigin: "direct-operator",
    cfg: {
      channels: { telegram: { ...telegram, apiRoot: fixture.cfg.channels.telegram.apiRoot } },
    },
    params: { to: "123", messageId: "42", ...params },
    ...context,
  });
const paragraph = (text: unknown) => ({ type: "paragraph", text });

it.each([
  { kind: "text", revoke: false },
  { kind: "text", revoke: true },
  { kind: "markup", revoke: true },
])("retains live authority for $kind edits (revoked: $revoke)", async ({ kind, revoke }) => {
  await withEditState(async () => {
    let current = true;
    const result = Promise.resolve(
      edit(
        kind === "text"
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
            },
        { botToken: `123456:edit-${kind}-${revoke}` },
        {
          assertDirectAdapterHandoff: () => {
            if (!current) {
              throw new Error("Progress owner retired");
            }
          },
        },
      ),
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
    await withEditState(async () => {
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
      await edit(
        { message: "Generic fallback must not replace the native card." },
        {
          botToken: `123456:progress-native-${richMessages}`,
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
        { accountId: "worker", progressSnapshot },
      );

      expect(requests).toEqual([
        {
          method: "editMessageText",
          fields: expect.objectContaining({ chat_id: "123", message_id: 42 }),
        },
      ]);
      const fields = requests[0]!.fields;
      if (richMessages) {
        expect(fields.text).toBeUndefined();
        expect(fields.parse_mode).toBeUndefined();
        expect(fields.rich_message).toMatchObject({
          skip_entity_detection: true,
          blocks: [
            paragraph({ type: "bold", text: "Working" }),
            paragraph(command),
            {
              type: "list",
              items: [
                {
                  has_checkbox: true,
                  is_checked: true,
                  blocks: [paragraph("Inspect <source> & config")],
                },
                {
                  has_checkbox: true,
                  blocks: [paragraph({ type: "bold", text: "Verify the result (in progress)" })],
                },
              ],
            },
          ],
        });
      } else {
        expect(fields.rich_message).toBeUndefined();
        expect(fields.parse_mode).toBe("HTML");
        expect(fields.text).toContain(
          "printf '&lt;ready&gt;&amp;' &amp;&amp; ./verify --flag=\"&lt;value&gt;\"",
        );
        expect(fields.text).toContain("[x] Inspect &lt;source&gt; &amp; config");
        expect(fields.text).toContain("[ ] <b>Verify the result (in progress)</b>");
        expect(fields.text).not.toContain("&amp;lt;");
        expect(fields.text).not.toContain("<code>");
      }
    });
  },
);

it.each([
  { name: "nonempty", caption: "Updated **caption**", expected: "Updated <b>caption</b>" },
  { name: "empty", caption: "", expected: "" },
])("routes registered $name caption edits to Telegram captions", async ({ caption, expected }) => {
  await withEditState(async () => {
    await edit(
      { message: "The caption must take precedence over text.", caption },
      { botToken: "123456:caption-edit", richMessages: true },
    );

    expect(requests).toEqual([
      {
        method: "editMessageCaption",
        fields: { chat_id: "123", message_id: 42, caption: expected, parse_mode: "HTML" },
      },
    ]);
  });
});
