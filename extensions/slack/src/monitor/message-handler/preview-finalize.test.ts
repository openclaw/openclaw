import type { WebClient } from "@slack/web-api";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const editSlackMessageMock = vi.fn();

// mock-isolation: Capture preview edits without Slack API calls.
vi.mock("../../actions.js", () => ({
  editSlackMessage: editSlackMessageMock,
  editSlackRenderedMessage: editSlackMessageMock,
}));

let finalizeSlackPreviewEdit: typeof import("./preview-finalize.js").finalizeSlackPreviewEdit;
type FinalizeParams = Parameters<typeof finalizeSlackPreviewEdit>[0];
const nativeBlocks = [
  {
    type: "data_visualization",
    title: "Revenue mix",
    chart: {
      type: "pie",
      segments: [
        { label: "Product", value: 60 },
        { label: "Services", value: 40 },
      ],
    },
  },
] as unknown as FinalizeParams["blocks"];
const fallbackText = "Revenue mix (pie chart)\n- Product: 60\n- Services: 40";

function finalize(client: WebClient, overrides: Partial<FinalizeParams> = {}) {
  return finalizeSlackPreviewEdit({
    client,
    token: "xoxb-test",
    channelId: "C123",
    messageId: "171234.567",
    text: "final answer",
    ...overrides,
  });
}

function createClient(historyMessages: Array<Record<string, unknown>> = []) {
  const replies = vi.fn<WebClient["conversations"]["replies"]>();
  replies.mockResolvedValue({ ok: true, messages: [] });
  const client = {
    conversations: {
      history: vi.fn(async () => ({ messages: historyMessages })),
      replies,
    },
  } as unknown as WebClient;
  return { client, replies };
}

describe("finalizeSlackPreviewEdit", () => {
  beforeAll(async () => {
    ({ finalizeSlackPreviewEdit } = await import("./preview-finalize.js"));
  });

  beforeEach(() => {
    editSlackMessageMock.mockReset().mockRejectedValueOnce(new Error("socket closed"));
  });

  it("recovers an applied edit beyond the first busy-thread readback page", async () => {
    const messageId = "171234.000101";
    const threadMessages = Array.from({ length: 102 }, (_, index) => ({
      ts: `171234.${String(index).padStart(6, "0")}`,
      text: index === 101 ? "final answer" : `message ${String(index)}`,
    }));
    const { client, replies } = createClient();
    replies.mockImplementationOnce(async ({ oldest, latest, inclusive, limit }) => ({
      ok: true,
      messages: threadMessages
        .filter(
          (message) =>
            (!oldest || message.ts > oldest || (inclusive && message.ts === oldest)) &&
            (!latest || message.ts < latest || (inclusive && message.ts === latest)),
        )
        .slice(0, limit),
    }));

    await expect(
      finalize(client, { messageId, threadTs: "171234.000000" }),
    ).resolves.toBeUndefined();
  });

  it("rethrows when readback does not match the expected final text", async () => {
    const { client } = createClient([{ ts: "171234.567", text: "partial draft" }]);

    await expect(finalize(client)).rejects.toThrow("socket closed");
  });

  it.each([true, false])(
    "accepts native-data fallback after an ambiguous response (blocks=%s)",
    async (withBlocks) => {
      const fallbackBlocks = [
        {
          type: "section",
          text: { type: "mrkdwn", text: fallbackText, verbatim: true },
        },
      ];
      const { client } = createClient([
        { ts: "171234.567", text: fallbackText, ...(withBlocks ? { blocks: fallbackBlocks } : {}) },
      ]);

      await expect(finalize(client, { text: "", blocks: nativeBlocks })).resolves.toBeUndefined();
    },
  );
});
