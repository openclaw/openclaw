// Matrix tests cover outbound preparation reuse before provider delivery.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "./sdk.js";

const bodyProjection = vi.hoisted(() => ({ count: 0 }));

vi.mock("./format.js", async () => {
  const actual = await vi.importActual<typeof import("./format.js")>("./format.js");
  return {
    ...actual,
    markdownToMatrixBody: (markdown: string) => {
      bodyProjection.count += 1;
      return actual.markdownToMatrixBody(markdown);
    },
  };
});

import { sendMessageMatrix } from "./send.js";

describe("sendMessageMatrix preparation performance", () => {
  beforeEach(() => {
    bodyProjection.count = 0;
  });

  it("projects a single-event body once before provider delivery", async () => {
    const sentContent: Array<Record<string, unknown>> = [];
    const client = {
      getUserId: async () => "@bot:example.org",
      prepareRoomForMessageSend: async () => "m.room.message",
      sendMessage: async (_roomId: string, content: Record<string, unknown>) => {
        sentContent.push(content);
        return "$event";
      },
    } as unknown as MatrixClient;

    await sendMessageMatrix("room:!room:example.org", "ordinary **Matrix** reply", {
      cfg: {},
      client,
    });

    expect(bodyProjection.count).toBe(1);
    expect(sentContent).toHaveLength(1);
    expect(sentContent[0]).toMatchObject({
      body: "ordinary **Matrix** reply",
      format: "org.matrix.custom.html",
    });
  });
});
