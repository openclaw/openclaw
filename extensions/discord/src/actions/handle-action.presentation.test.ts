import { beforeEach, describe, expect, it } from "vitest";
import {
  discordConfig,
  handleDiscordActionMock,
  handleDiscordMessageAction,
} from "./handle-action.test-support.js";

describe("handleDiscordMessageAction presentations", () => {
  beforeEach(() => {
    handleDiscordActionMock.mockClear();
  });

  it("downgrades oversized table presentations to complete text", async () => {
    const cfg = discordConfig();
    const authoredText = `${"x".repeat(1997)}AUTHORED_TAIL`;

    await handleDiscordMessageAction({
      action: "send",
      params: {
        to: "channel:123",
        presentation: {
          title: authoredText,
          blocks: [
            { type: "text", text: authoredText },
            { type: "context", text: authoredText },
            {
              type: "buttons",
              buttons: [{ label: `${"x".repeat(80)}LABEL_TAIL`, value: "choice" }],
            },
            {
              type: "table",
              caption: "Large pipeline",
              headers: ["Account", "Stage"],
              rows: Array.from({ length: 900 }, (_entry, index) => [
                `account-${String(index)}-${"x".repeat(80)}`,
                "Review",
              ]),
            },
          ],
        },
      },
      cfg,
    });

    const [call] = handleDiscordActionMock.mock.calls;
    const payload = call?.[0] as Record<string, unknown> | undefined;
    expect(payload?.components).toBeUndefined();
    expect(payload?.content).toEqual(expect.stringContaining("account-0-"));
    expect(payload?.content).toEqual(expect.stringContaining("account-899-"));
    expect(String(payload?.content).split("AUTHORED_TAIL")).toHaveLength(4);
    expect(payload?.content).toEqual(expect.stringContaining("LABEL_TAIL"));
  });
});
