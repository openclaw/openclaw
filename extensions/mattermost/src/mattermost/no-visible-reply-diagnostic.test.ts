import { describe, expect, it } from "vitest";
import { formatMattermostFinalDeliveryOutcomeLog } from "./monitor-context.js";

describe("Mattermost no-visible-reply diagnostics", () => {
  it.each([
    {
      label: "substantive text",
      payload: { text: "Here is the result of the work I did..." },
      expected: "finalTextLength=39 mediaUrlCount=0",
    },
    {
      label: "a media URL",
      payload: { mediaUrl: "https://example.org/a.png" },
      expected: "finalTextLength=0 mediaUrlCount=1",
    },
    {
      label: "SDK media-list precedence",
      payload: {
        mediaUrl: "https://example.org/a.png",
        mediaUrls: ["https://example.org/b.png", "https://example.org/c.png"],
      },
      expected: "finalTextLength=0 mediaUrlCount=2",
    },
    {
      label: "trimmed text",
      payload: { text: "   hello   " },
      expected: "finalTextLength=5 mediaUrlCount=0",
    },
  ])("reports dropped $label with an unknown agent (#80501)", ({ payload, expected }) => {
    expect(
      formatMattermostFinalDeliveryOutcomeLog({
        outcome: "empty",
        payload,
        to: "channel:x",
        accountId: "y",
        agentId: undefined,
      }),
    ).toBe(
      `mattermost no-visible-reply: no-visible-reply-after-final-delivery to=channel:x accountId=y agentId=unknown outcome=empty ${expected}`,
    );
  });

  it.each([{}, { text: "" }, { text: "   \n\t  " }])(
    "does not report nominally empty payloads: %j",
    (payload) => {
      expect(
        formatMattermostFinalDeliveryOutcomeLog({
          outcome: "empty",
          payload,
          to: "channel:x",
          accountId: "y",
          agentId: undefined,
        }),
      ).toBeUndefined();
    },
  );
});
