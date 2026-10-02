import {
  renderPresentationForDelivery,
  type MessagePresentationBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createActionCard } from "./flex-templates/basic-cards.js";
import { lineOutboundAdapter } from "./outbound.js";
import type { LineRichCard } from "./rich-message-schema.js";
import {
  createLineQuickReply,
  lineMessageActions,
  prepareLineReplyPayload,
  renderLineCard,
} from "./rich-messages.js";

const DIRECT_TARGET = "line:U0123456789abcdef0123456789abcdef";
const QUESTION_ID = "ask_3d8dbe55be452a9a39add7c909beb119";

function questionPayload({
  labels = ["Staging", "Production"],
  title,
  prompt = { type: "text", text: "Which environment?" },
  other = false,
}: {
  labels?: string[];
  title?: string;
  prompt?: MessagePresentationBlock | null;
  other?: boolean;
} = {}): ReplyPayload {
  return {
    text: `Which environment?\n${labels.join(" / ")}${other ? " / Other: reply with your own answer." : ""}`,
    presentationTextMode: "fallback",
    channelData: { askUser: { questionId: QUESTION_ID, optionValues: labels } },
    presentation: {
      title,
      blocks: [
        ...(prompt ? [prompt] : []),
        {
          type: "buttons",
          buttons: [
            ...labels.map((label) => ({
              label,
              action: { type: "question" as const, questionId: QUESTION_ID, optionValue: label },
            })),
            ...(other
              ? [
                  {
                    label: "Other…",
                    action: {
                      type: "question" as const,
                      questionId: QUESTION_ID,
                      intent: "custom-input" as const,
                    },
                  },
                ]
              : []),
          ],
        },
      ],
    },
  };
}

async function prepareBoth(payload: ReplyPayload, to = DIRECT_TARGET) {
  const outbound = await renderPresentationForDelivery(
    {
      presentationCapabilities: lineOutboundAdapter.presentationCapabilities,
      renderPresentation: (adapted, sourcePresentation) =>
        lineOutboundAdapter.renderPresentation!({
          payload: adapted,
          presentation: adapted.presentation,
          sourcePresentation,
          ctx: { cfg: {}, to, text: adapted.text ?? "", payload: adapted },
        }),
    },
    payload,
  );
  return [await prepareLineReplyPayload(payload, to), outbound];
}

describe("LINE rich-message boundaries", () => {
  it("exposes a validating rich-message schema for configured accounts", () => {
    const discovery = lineMessageActions.describeMessageTool({
      cfg: { channels: { line: { channelAccessToken: "token", channelSecret: "secret" } } },
    });
    const contribution = Array.isArray(discovery?.schema) ? discovery.schema[0] : discovery?.schema;
    const schema = contribution?.properties.channelData;
    if (!schema) {
      throw new Error("expected LINE channelData schema");
    }
    const location = { title: "Office", address: "1 Main St", latitude: 35.6, longitude: 139.7 };
    expect(Value.Check(schema, { line: { location } })).toBe(true);
    expect(Value.Check(schema, { line: { location: { ...location, latitude: 91 } } })).toBe(false);
  });

  it.each([
    { to: DIRECT_TARGET, native: true },
    { to: "line:group:C0123456789abcdef0123456789abcdef", native: false },
  ])("renders question choices for destination $to", async ({ to, native }) => {
    const payload = questionPayload();
    for (const prepared of await prepareBoth(payload, to)) {
      expect(prepared.presentation).toBeUndefined();
      if (native) {
        expect(prepared.channelData?.line).toMatchObject({
          flexMessage: {
            altText: "Which environment?",
            contents: {
              footer: {
                contents: [0, 1].map((index) => ({
                  action: {
                    type: "postback",
                    data: `line.question=${QUESTION_ID}&line.option=${index}`,
                  },
                })),
              },
            },
          },
        });
      } else {
        expect(prepared.channelData?.line).toBeUndefined();
        expect(prepared.text).toBe(payload.text);
      }
    }
  });

  it.each([
    ["blank prompt with guidance", " ", { type: "text", text: " " }, true, false],
    ["title-only prompt", "Which environment?", null, false, true],
    ["context prompt", "", { type: "context", text: "Which environment?" }, false, true],
  ] as const)(
    "preserves the %s through both render owners",
    async (_name, title, prompt, other, native) => {
      const payload = questionPayload({
        title,
        prompt,
        other,
        labels: ["Staging", "Production", "Canary", "Sandbox"],
      });
      for (const prepared of await prepareBoth(payload)) {
        expect(prepared.presentation).toBeUndefined();
        if (native) {
          expect(prepared.channelData?.line).toHaveProperty("flexMessage");
          expect(JSON.stringify(prepared.channelData?.line)).toContain("Which environment?");
        } else {
          expect(prepared.channelData?.line).toBeUndefined();
          expect(prepared.text).toBe(payload.text);
        }
      }
    },
  );

  it("names the omitted Other control below and above the action budget", async () => {
    for (const optionCount of [2, 4]) {
      const labels = ["Staging", "Production", "Canary", "Sandbox"].slice(0, optionCount);
      const prepared = await prepareLineReplyPayload(
        questionPayload({ labels, other: true }),
        DIRECT_TARGET,
      );
      expect(prepared.channelData?.line).toMatchObject({
        flexMessage: {
          contents: {
            body: {
              contents: expect.arrayContaining([
                expect.objectContaining({ text: "Which environment?\nActions:\n- Other…" }),
              ]),
            },
            footer: {
              contents: labels.map((_, index) => ({
                action: { data: `line.question=${QUESTION_ID}&line.option=${index}` },
              })),
            },
          },
        },
      });
    }
  });

  it("falls back when two question options truncate to the same label", async () => {
    const labels = [
      "Deploy the release candidate to the shared staging cluster",
      "Deploy the release candidate to the shared production cluster",
    ];
    const payload = questionPayload({ labels });
    const prepared = await prepareLineReplyPayload(payload, DIRECT_TARGET);
    expect(prepared.channelData?.line).toBeUndefined();
    expect(prepared.text).toBe(payload.text);
  });
  it.each([
    { name: "exact byte limit", character: "x", extraBytes: 0, fits: true },
    { name: "multibyte overflow", character: "界", extraBytes: 1, fits: false },
  ])(
    "preserves the answer and controls at the Flex $name",
    async ({ character, extraBytes, fits }) => {
      const title = "Size boundary";
      const action = {
        type: "postback",
        label: "Continue",
        data: "next",
        displayText: "Continue",
      } as const;
      const overhead =
        Buffer.byteLength(
          JSON.stringify(createActionCard(title, "x", [{ label: "Continue", action }])),
          "utf8",
        ) - 1;
      const text = character.repeat(
        Math.ceil((30_000 - overhead + extraBytes) / Buffer.byteLength(character, "utf8")),
      );
      const prepared = await prepareLineReplyPayload({
        text: "Full answer:",
        presentation: {
          title,
          blocks: [
            { type: "text", text },
            {
              type: "buttons",
              buttons: [{ label: "Continue", action: { type: "callback", value: "next" } }],
            },
          ],
        },
      });

      expect(prepared.presentation).toBeUndefined();
      if (fits) {
        const line = prepared.channelData?.line as { flexMessage: { contents: unknown } };
        expect(Buffer.byteLength(JSON.stringify(line.flexMessage.contents), "utf8")).toBe(30_000);
        expect(prepared.text).toBe("Full answer:");
      } else {
        expect(prepared.channelData?.line).toBeUndefined();
        expect(prepared.text).toContain("Full answer:");
        expect(prepared.text).toContain(text);
        expect(prepared.text).toContain("Continue");
      }
    },
  );

  it("keeps fallback text when only quick replies render", async () => {
    const prepared = await prepareLineReplyPayload({
      text: "Agent needs input:\n1. Alpha",
      presentationTextMode: "fallback",
      presentation: {
        blocks: [
          {
            type: "select",
            options: [{ label: "Alpha", action: { type: "callback", value: "alpha" } }],
          },
        ],
      },
    });

    const line = prepared.channelData?.line as
      | { quickReplyItems?: unknown[]; flexMessage?: unknown }
      | undefined;
    expect(prepared.text).toBe("Agent needs input:\n1. Alpha");
    expect(line?.flexMessage).toBeUndefined();
    expect(line?.quickReplyItems).toHaveLength(1);
  });

  it.each(["   "])("keeps the select prompt when fallback text is %j", async (text) => {
    const prepared = await prepareLineReplyPayload({
      text,
      presentationTextMode: "fallback",
      presentation: {
        title: "Choose a deployment",
        blocks: [
          {
            type: "select",
            placeholder: "Which environment should receive this deployment?",
            options: [{ label: "Staging", action: { type: "callback", value: "staging" } }],
          },
        ],
      },
    });

    expect(prepared.text).toBe(
      "Choose a deployment\n\nWhich environment should receive this deployment?",
    );
  });

  it("preserves full select prompts and overflow labels while bounding native labels", async () => {
    const placeholder = "Which region should receive this deployment?";
    const options = Array.from({ length: 8 }, (_, index) => ({
      label: `Deployment region number ${index + 1}`,
      action: { type: "command" as const, command: `/region ${index + 1}` },
    }));
    const prepared = await prepareLineReplyPayload({
      presentation: {
        blocks: [
          { type: "select", placeholder: "Choose the first region", options },
          { type: "select", placeholder, options },
        ],
      },
    });
    const line = prepared.channelData?.line as {
      quickReplyItems: Parameters<typeof createLineQuickReply>[0];
    };

    expect(prepared.text).toBe(
      `Choose the first region\n\n${placeholder}:\n` +
        options
          .slice(5)
          .map((option) => `- ${option.label}: \`${option.action.command}\``)
          .join("\n"),
    );
    const native = createLineQuickReply(line.quickReplyItems);
    expect(native.items).toHaveLength(13);
    expect(native.items?.every((item) => (item.action?.label?.length ?? 0) <= 20)).toBe(true);
    expect(native.items?.at(-1)?.action).toMatchObject({ type: "message", text: "/region 5" });
  });

  it("keeps the overflow options beside a Flex card without repeating the card", async () => {
    const block = (prefix: string) => ({
      type: "select" as const,
      options: Array.from({ length: 8 }, (_, index) => ({
        label: `${prefix}-${index + 1}`,
        action: { type: "callback" as const, value: `${prefix}-${index + 1}` },
      })),
    });

    const prepared = await prepareLineReplyPayload({
      text: "Choose a target.",
      presentation: {
        title: "Deploy",
        blocks: [
          { type: "text", text: "Staging is green." },
          {
            type: "buttons",
            buttons: [{ label: "Deploy", action: { type: "command", command: "/deploy" } }],
          },
          block("env"),
          block("region"),
        ],
      },
    });

    const line = prepared.channelData?.line as {
      flexMessage?: unknown;
      quickReplyItems?: unknown[];
    };
    expect(line.flexMessage).toBeDefined();
    expect(line.quickReplyItems).toHaveLength(13);
    expect(prepared.text).toContain("region-8");
    expect(prepared.text).not.toContain("Staging is green.");
    expect(prepared.text).not.toContain("Deploy");
  });

  it("keeps a table beside a select instead of dropping it", async () => {
    const prepared = await prepareLineReplyPayload({
      text: "Here is this week's usage.",
      presentation: {
        blocks: [
          { type: "table", caption: "Runs", headers: ["Day", "Runs"], rows: [["Mon", "12"]] },
          {
            type: "select",
            options: [{ label: "Mon", action: { type: "callback", value: "mon" } }],
          },
        ],
      },
    });

    expect(prepared.text).toContain("Here is this week's usage.");
    expect(prepared.text).toContain("Runs");
    expect(prepared.text).toContain("12");
  });

  it.each([
    {
      kind: "command",
      action: { type: "command", command: "/status" },
      expected: { type: "message", text: "/status" },
    },
    {
      kind: "callback",
      action: { type: "callback", value: "action=status" },
      expected: { type: "postback", data: "action=status" },
    },
    {
      kind: "url",
      action: { type: "url", url: "https://example.com/status" },
      expected: { type: "uri", uri: "https://example.com/status" },
    },
    {
      kind: "web-app",
      action: { type: "web-app", url: "https://example.com/app" },
      expected: { type: "uri", uri: "https://example.com/app" },
    },
  ] as const)(
    "preserves 40-character Flex $kind labels while quick replies stay bounded",
    async ({ action, expected }) => {
      const label = "x".repeat(40);
      const result = await lineOutboundAdapter.renderPresentation?.({
        payload: { text: "Choose one" },
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                { label, action },
                { label: `${label}y`, action },
              ],
            },
            {
              type: "select",
              options: [{ label, action: { type: "callback", value: "quick" } }],
            },
          ],
        },
        ctx: {} as never,
      });
      const line = result?.channelData?.line as {
        flexMessage: { contents: { footer: { contents: Array<{ action: { label: string } }> } } };
        quickReplyItems: unknown[];
      };

      expect(line.flexMessage.contents.footer.contents).toMatchObject([
        { action: { ...expected, label } },
        { action: { ...expected, label } },
      ]);
      expect(createLineQuickReply(line.quickReplyItems as never)).toMatchObject({
        items: [{ action: { type: "postback", data: "quick", label: "x".repeat(20) } }],
      });
    },
  );

  it("renders each typed card through its existing LINE Flex path", () => {
    const cards: LineRichCard[] = [
      { type: "media_player", title: "Song" },
      { type: "event", title: "Meeting", date: "Monday" },
      { type: "agenda", title: "Today", events: [{ title: "Standup" }] },
      { type: "device", name: "TV" },
      { type: "appletv_remote" },
    ];

    for (const card of cards) {
      expect(renderLineCard(card).contents).toMatchObject({ type: "bubble" });
    }
  });
});
