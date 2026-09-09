import { describe, expect, it } from "vitest";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import { assembleMSTeamsInboundFacts, prepareMSTeamsDebounceEntry } from "./inbound-facts.js";

function context(activity: MSTeamsTurnContext["activity"]): MSTeamsTurnContext {
  return { activity } as MSTeamsTurnContext;
}

describe("msteams inbound facts", () => {
  it("prefers activity text, then HTML, then adaptive-card values", async () => {
    const textEntry = await prepareMSTeamsDebounceEntry({
      context: context({
        type: "message",
        text: "  <at>Bot</at> hello &lt;tag&gt;  ",
        attachments: [{ contentType: "text/html", content: "<p>ignored</p>" }],
        value: { action: "ignored" },
      }),
    });
    const htmlEntry = await prepareMSTeamsDebounceEntry({
      context: context({
        type: "message",
        attachments: [{ contentType: "text/html", content: "<p>hello &amp; goodbye</p>" }],
      }),
    });
    const valueEntry = await prepareMSTeamsDebounceEntry({
      context: context({
        type: "message",
        value: { action: "approve", id: 7 },
      }),
    });

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
    const entry = await prepareMSTeamsDebounceEntry({
      context: context({
        type: "message",
        attachments: [{ contentType: "text/html", content: html }],
        value: { action: "ignored" },
      }),
    });

    expect(assembleMSTeamsInboundFacts({ entry, mediaMaxBytes: 1024 }).rawBody).toBe(expected);
  });

  it("strips native mentions from card text when HTML has no visible text", async () => {
    const entry = await prepareMSTeamsDebounceEntry({
      context: context({
        type: "message",
        attachments: [{ contentType: "text/html", content: "<at>Bot</at>" }],
        value: "<at>Bot</at> answer &lt;tag&gt;",
      }),
    });

    expect(entry.text).toBe("answer &lt;tag&gt;");
  });

  it("preserves raw Bot Framework IDs while normalizing routing facts", async () => {
    const entry = await prepareMSTeamsDebounceEntry({
      context: context({
        type: "message",
        id: "message-1",
        text: "hello",
        from: { id: "user-1", aadObjectId: "aad-1", name: "Alice" },
        recipient: { id: "bot-1", name: "Bot" },
        conversation: {
          id: "19:channel@thread.tacv2;messageid=thread-root",
          conversationType: "channel",
        },
        channelData: {
          team: { id: "team-1" },
          channel: { id: "channel-1" },
          tenant: { id: "tenant-1" },
        },
        serviceUrl: "https://smba.trafficmanager.net/amer/",
      }),
    });

    const facts = assembleMSTeamsInboundFacts({ entry, mediaMaxBytes: 1024 });

    expect(facts.rawConversationId).toBe("19:channel@thread.tacv2;messageid=thread-root");
    expect(facts.conversationId).toBe("19:channel@thread.tacv2");
    expect(facts.conversationMessageId).toBe("thread-root");
    expect(facts.threadId).toBe("thread-root");
    expect(facts.conversationRef).toMatchObject({
      tenantId: "tenant-1",
      teamId: "team-1",
      threadId: "thread-root",
      conversation: {
        id: "19:channel@thread.tacv2",
        tenantId: "tenant-1",
      },
    });
  });
});
