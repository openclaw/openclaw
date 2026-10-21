import { describe, expect, it } from "vitest";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import { assembleMSTeamsInboundFacts, prepareMSTeamsDebounceEntry } from "./inbound-facts.js";

function prepare(activity: Omit<MSTeamsTurnContext["activity"], "type">) {
  return prepareMSTeamsDebounceEntry({
    accountId: "default",
    context: { activity: { type: "message", ...activity } } as MSTeamsTurnContext,
  });
}

describe("msteams inbound facts", () => {
  it("prefers activity text, then HTML, then adaptive-card values", async () => {
    const textEntry = await prepare({
      text: "  <at>Bot</at> hello &lt;tag&gt;  ",
      attachments: [{ contentType: "text/html", content: "<p>ignored</p>" }],
      value: { action: "ignored" },
    });
    const htmlEntry = await prepare({
      attachments: [{ contentType: "text/html", content: "<p>hello &amp; goodbye</p>" }],
    });
    const valueEntry = await prepare({ value: { action: "approve", id: 7 } });

    expect(textEntry.text).toBe("hello &lt;tag&gt;");
    expect(htmlEntry.text).toBe("hello & goodbye");
    expect(valueEntry.text).toContain("approve");
    expect(valueEntry.text).toContain("7");
  });

  it.each([
    ["<p>Use x &lt; 5 and &#39;yes&#39; &copy;</p>", "Use x < 5 and 'yes' ©"],
    ["<p>Smile &#x1F600; and &quot;hello&quot;</p>", 'Smile 😀 and "hello"'],
    ["<p>literal &amp;lt;tag&amp;gt;</p>", "literal &lt;tag&gt;"],
    ["<p>literal &lt;at&gt;Alice&lt;/at&gt;</p>", "literal <at>Alice</at>"],
    ["<p>one<br>two</p><p>three&nbsp;four</p>", "one two three four"],
    [
      '<at>Bot</at><p>See <a href="https://example.test/?a=1&amp;b=2">report</a></p>',
      "See report https://example.test/?a=1&b=2",
    ],
  ])("preserves HTML text in the inbound body: %s", async (html, expected) => {
    const entry = await prepare({
      attachments: [{ contentType: "text/html", content: html }],
      value: { action: "ignored" },
    });

    expect(assembleMSTeamsInboundFacts(entry).rawBody).toBe(expected);
  });

  it("strips native mentions from card text when HTML has no visible text", async () => {
    const entry = await prepare({
      attachments: [{ contentType: "text/html", content: "<at>Bot</at>" }],
      value: "<at>Bot</at> answer &lt;tag&gt;",
    });

    expect(entry.text).toBe("answer &lt;tag&gt;");
  });

  it("preserves raw Bot Framework IDs while normalizing routing facts", async () => {
    const entry = await prepare({
      conversation: {
        id: "19:channel@thread.tacv2;messageid=thread-root",
        conversationType: "channel",
      },
      channelData: {
        team: { id: "team-1" },
        tenant: { id: "tenant-1" },
      },
    });

    expect(assembleMSTeamsInboundFacts(entry)).toMatchObject({
      rawConversationId: "19:channel@thread.tacv2;messageid=thread-root",
      conversationId: "19:channel@thread.tacv2",
      conversationMessageId: "thread-root",
      threadId: "thread-root",
      conversationRef: {
        tenantId: "tenant-1",
        teamId: "team-1",
        threadId: "thread-root",
        conversation: {
          id: "19:channel@thread.tacv2",
          tenantId: "tenant-1",
        },
      },
    });
  });
});
