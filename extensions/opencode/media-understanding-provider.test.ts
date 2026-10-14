import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  describeImageWithModelPayloadTransform:
    vi.fn<
      (request: unknown, onPayload: (payload: unknown) => unknown) => Promise<{ text: string }>
    >(),
}));

vi.mock("openclaw/plugin-sdk/media-understanding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-understanding")>()),
  describeImageWithModelPayloadTransform: mocks.describeImageWithModelPayloadTransform,
}));

import { opencodeMediaUnderstandingProvider } from "./media-understanding-provider.js";

beforeEach(() => {
  mocks.describeImageWithModelPayloadTransform.mockReset();
});

async function applyImagePayloadTransform(payload: Record<string, unknown>): Promise<void> {
  mocks.describeImageWithModelPayloadTransform.mockImplementationOnce(
    async (_request, onPayload) => {
      await onPayload(payload);
      return { text: "ok" };
    },
  );
  await opencodeMediaUnderstandingProvider.describeImage?.({} as never);
}

describe("opencode media understanding provider", () => {
  it.each(["none", { effort: "none" }])(
    "strips disabled Responses reasoning %j",
    async (reasoning) => {
      const payload = {
        reasoning,
        include: ["reasoning.encrypted_content"],
        store: false,
      };

      await applyImagePayloadTransform(payload);

      expect(JSON.stringify(payload)).toBe(
        '{"include":["reasoning.encrypted_content"],"store":false}',
      );
    },
  );

  it("keeps supported Responses reasoning payloads", async () => {
    const payload = {
      reasoning: { effort: "low" },
      store: false,
    };

    await applyImagePayloadTransform(payload);

    expect(payload).toEqual({
      reasoning: { effort: "low" },
      store: false,
    });
  });
});
