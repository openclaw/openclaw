import type { WebClient } from "@slack/web-api";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const editSlackMessageMock = vi.fn();

vi.mock("../../actions.js", () => ({
  editSlackMessage: (...args: unknown[]) =>
    editSlackMessageMock(...(args as Parameters<typeof editSlackMessageMock>)),
  editSlackRenderedMessage: (...args: unknown[]) =>
    editSlackMessageMock(...(args as Parameters<typeof editSlackMessageMock>)),
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
  return {
    conversations: {
      history: vi.fn(async () => ({ messages: historyMessages })),
      replies: vi.fn(async () => ({ messages: [] })),
    },
  } as unknown as WebClient;
}

describe("finalizeSlackPreviewEdit", () => {
  beforeAll(async () => {
    ({ finalizeSlackPreviewEdit } = await import("./preview-finalize.js"));
  });

  beforeEach(() => {
    editSlackMessageMock.mockReset().mockRejectedValueOnce(new Error("socket closed"));
  });

  it("recovers an applied edit beyond the first busy-thread readback page", async () => {
    editSlackMessageMock.mockReset().mockRejectedValueOnce(new Error("socket closed after commit"));
    const messageId = "171234.000101";
    const threadMessages = Array.from({ length: 102 }, (_, index) => ({
      ts: `171234.${String(index).padStart(6, "0")}`,
      text: index === 101 ? "final answer" : `message ${String(index)}`,
    }));
    const client = createClient();
    (client.conversations.replies as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      ({
        oldest,
        latest,
        inclusive,
        limit,
      }: {
        oldest?: string;
        latest?: string;
        inclusive?: boolean;
        limit?: number;
      }) => ({
        messages: threadMessages
          .filter(
            (message) =>
              (!oldest || message.ts > oldest || (inclusive && message.ts === oldest)) &&
              (!latest || message.ts < latest || (inclusive && message.ts === latest)),
          )
          .slice(0, limit),
      }),
    );

    await expect(
      finalize(client, { messageId, threadTs: "171234.000000" }),
    ).resolves.toBeUndefined();
  });

  it("rethrows when readback does not match the expected final text", async () => {
    const client = createClient([{ ts: "171234.567", text: "partial draft" }]);

    await expect(finalize(client)).rejects.toThrow("socket closed");
  });

  it("accepts native-data fallback blocks after an ambiguous retry response", async () => {
    const fallbackBlocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: fallbackText, verbatim: true },
      },
    ];
    const client = createClient([{ ts: "171234.567", text: fallbackText, blocks: fallbackBlocks }]);

    await expect(finalize(client, { text: "", blocks: nativeBlocks })).resolves.toBeUndefined();
  });

  it("accepts native-data text fallback without blocks after an ambiguous retry response", async () => {
    const client = createClient([{ ts: "171234.567", text: fallbackText }]);

    await expect(finalize(client, { text: "", blocks: nativeBlocks })).resolves.toBeUndefined();
  });
});
