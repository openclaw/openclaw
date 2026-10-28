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

  it.each([true, false])("preserves current links with activity text=%s", async (hasText) => {
    const body = "Log 20 minutes for Pat on Plane";
    const url = "https://plane.example.test/team/browse/DEMO-9/";
    const entry = await prepareMSTeamsDebounceEntry({
      accountId: "default",
      context: context({
        type: "message",
        ...(hasText ? { text: body } : {}),
        attachments: [
          {
            contentType: "text/html",
            content: `<p>Log 20 minutes for Pat on <a href="${url}">Plane</a></p>`,
          },
        ],
      }),
    });
    expect(assembleMSTeamsInboundFacts(entry).rawBody).toBe(`${body}${hasText ? "\n" : " "}${url}`);
  });

  it.each([true, false])(
    "isolates quoted tasks and mentions with activity text=%s",
    async (hasText) => {
      const entry = await prepareMSTeamsDebounceEntry({
        accountId: "default",
        context: context({
          type: "message",
          ...(hasText ? { text: "Use this task" } : {}),
          attachments: [
            {
              contentType: "text/html",
              content:
                '<blockquote itemtype="http://schema.skype.com/Reply"><p itemprop="copy">Old <a href="https://example.test/OLD-1">task</a></p><blockquote><a href="https://example.test/OLD-2">nested</a></blockquote></blockquote><at><a href="https://example.test/person">Bot</a></at><p>Use <a href="https://example.test/NEW-3">this task</a></p>',
            },
          ],
        }),
      });
      const facts = assembleMSTeamsInboundFacts(entry);
      expect(facts.rawBody).toBe(`Use this task${hasText ? "\n" : " "}https://example.test/NEW-3`);
      expect(facts.quoteInfo?.body).toBe("Old task");
    },
  );

  it.each([true, false])(
    "does not add unsafe anchor destinations with activity text=%s",
    async (hasText) => {
      const entry = await prepareMSTeamsDebounceEntry({
        accountId: "default",
        context: context({
          type: "message",
          ...(hasText ? { text: "one two three four five" } : {}),
          attachments: [
            {
              contentType: "text/html",
              content:
                '<a href="javascript:alert(1)">one</a><a href="data:text/plain,secret">two</a><a href="file:///private/example">three</a><a href="https://user:pass@example.test/">four</a><a href="https://example.test/&#10;spoof">five</a>',
            },
          ],
        }),
      });
      expect(entry.text).toBe("one two three four five");
    },
  );

  it("adds multiple distinct links once, decodes href entities, and keeps text authoritative", async () => {
    const entry = await prepareMSTeamsDebounceEntry({
      accountId: "default",
      context: context({
        type: "message",
        text: "Compare https://example.test/one with two and three",
        attachments: [
          {
            contentType: "text/html",
            content:
              '<p>HTML-only noise <a href="https://example.test/one">one</a><a href="https://example.test/two?a=1&amp;b=2">two</a><a href="https://example.test/two?a=1&amp;b=2">duplicate</a><a href=https://example.test/three>three</a></p>',
          },
        ],
      }),
    });
    expect(entry.text).toBe(
      "Compare https://example.test/one with two and three\nhttps://example.test/two?a=1&b=2\nhttps://example.test/three",
    );
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
      conversation: { id: "19:channel@thread.tacv2;messageid=thread-root" },
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
