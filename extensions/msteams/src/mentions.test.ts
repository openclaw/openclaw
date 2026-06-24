// Msteams tests cover mentions plugin behavior.
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { parseMentions } from "./mentions.js";
import { buildActivity, sendMSTeamsMessages } from "./messenger.js";

// Parse the Teams mention markup in activity.text using an independent DOM parser
// (jsdom) so the structural assertion does not depend on the same code under test.
function parseAtStructure(html: string) {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  return {
    atCount: doc.querySelectorAll("at").length,
    nestedAt: doc.querySelectorAll("at at").length,
    hasInjectedChild: (doc.querySelector("at")?.children?.length ?? 0) > 0,
    textContent: doc.querySelector("at")?.textContent ?? null,
  };
}

function requireFirstEntity(result: ReturnType<typeof parseMentions>) {
  const entity = result.entities[0];
  if (!entity) {
    throw new Error("expected parseMentions to return at least one entity");
  }
  return entity;
}

function requireOnlyEntity(result: ReturnType<typeof parseMentions>) {
  expect(result.entities).toHaveLength(1);
  return requireFirstEntity(result);
}

describe("mention-free text contract", () => {
  it("parseMentions handles text without mentions", () => {
    const result = parseMentions("Hello world!");

    expect(result.text).toBe("Hello world!");
    expect(result.entities).toHaveLength(0);
  });
});

describe("parseMentions", () => {
  it("parses single mention", () => {
    const result = parseMentions("Hello @[John Doe](28:a1b2c3-d4e5f6)!");

    expect(result.text).toBe("Hello <at>John Doe</at>!");
    expect(requireOnlyEntity(result)).toEqual({
      type: "mention",
      text: "<at>John Doe</at>",
      mentioned: {
        id: "28:a1b2c3-d4e5f6",
        name: "John Doe",
      },
    });
  });

  it("parses multiple mentions", () => {
    const result = parseMentions("Hey @[Alice](28:aaa) and @[Bob](28:bbb), can you review this?");

    expect(result.text).toBe("Hey <at>Alice</at> and <at>Bob</at>, can you review this?");
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]).toEqual({
      type: "mention",
      text: "<at>Alice</at>",
      mentioned: {
        id: "28:aaa",
        name: "Alice",
      },
    });
    expect(result.entities[1]).toEqual({
      type: "mention",
      text: "<at>Bob</at>",
      mentioned: {
        id: "28:bbb",
        name: "Bob",
      },
    });
  });

  it("handles empty text", () => {
    const result = parseMentions("");

    expect(result.text).toBe("");
    expect(result.entities).toHaveLength(0);
  });

  it("handles mention with spaces in name", () => {
    const result = parseMentions("@[John Peter Smith](28:a1b2c3)");

    expect(result.text).toBe("<at>John Peter Smith</at>");
    expect(requireFirstEntity(result).mentioned.name).toBe("John Peter Smith");
  });

  it("trims whitespace from id and name", () => {
    const result = parseMentions("@[ John Doe ]( 28:a1b2c3 )");

    expect(requireOnlyEntity(result)).toEqual({
      type: "mention",
      text: "<at>John Doe</at>",
      mentioned: {
        id: "28:a1b2c3",
        name: "John Doe",
      },
    });
  });

  it("escapes markup characters in mention tags and keeps entity text aligned", () => {
    const result = parseMentions("Hi @[Tom & <b>Jerry</b>](28:abc-123)");
    const expectedMention = "<at>Tom &amp; &lt;b&gt;Jerry&lt;/b&gt;</at>";

    expect(result.text).toBe(`Hi ${expectedMention}`);
    const entity = requireOnlyEntity(result);
    expect(entity).toEqual({
      type: "mention",
      text: expectedMention,
      mentioned: {
        id: "28:abc-123",
        name: "Tom & <b>Jerry</b>",
      },
    });

    const start = result.text.indexOf("<at>");
    const end = result.text.indexOf("</at>", start) + "</at>".length;
    expect(result.text.slice(start, end)).toBe(entity.text);
  });

  it("escapes closing at tags inside mention names", () => {
    const result = parseMentions("Hi @[A</at><at>B](28:abc)");
    const expectedMention = "<at>A&lt;/at&gt;&lt;at&gt;B</at>";

    expect(result.text).toBe(`Hi ${expectedMention}`);
    expect(requireOnlyEntity(result).text).toBe(expectedMention);
    expect(result.text).not.toContain("A</at><at>B");
  });

  it("handles Japanese characters in mention at start of message", () => {
    const input = "@[タナカ タロウ](a1b2c3d4-e5f6-7890-abcd-ef1234567890) スキル化完了しました！";
    const result = parseMentions(input);

    expect(result.text).toBe("<at>タナカ タロウ</at> スキル化完了しました！");
    expect(requireOnlyEntity(result)).toEqual({
      type: "mention",
      text: "<at>タナカ タロウ</at>",
      mentioned: {
        id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        name: "タナカ タロウ",
      },
    });

    // Verify entity text exactly matches what's in the formatted text
    const entityText = requireFirstEntity(result).text;
    expect(result.text).toContain(entityText);
    expect(result.text.indexOf(entityText)).toBe(0);
  });

  it("skips mention-like patterns with non-Teams IDs (e.g. in code blocks)", () => {
    // This reproduces the actual failing payload: the message contains a real mention
    // plus `@[表示名](ユーザーID)` as documentation text inside backticks.
    const input =
      "@[タナカ タロウ](a1b2c3d4-e5f6-7890-abcd-ef1234567890) スキル化完了しました！📋\n\n" +
      "**作成したスキル:** `teams-mention`\n" +
      "- 機能: Teamsでのメンション形式 `@[表示名](ユーザーID)`\n\n" +
      "**追加対応:**\n" +
      "- ユーザーのID `a1b2c3d4-e5f6-7890-abcd-ef1234567890` を登録済み";
    const result = parseMentions(input);

    // Only the real mention should be parsed; the documentation example should be left as-is
    const firstEntity = requireOnlyEntity(result);
    expect(firstEntity.mentioned.id).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(firstEntity.mentioned.name).toBe("タナカ タロウ");

    // The documentation pattern must remain untouched in the text
    expect(result.text).toContain("`@[表示名](ユーザーID)`");
  });

  it("accepts Bot Framework IDs (28:xxx)", () => {
    const result = parseMentions("@[Bot](28:abc-123)");
    expect(requireOnlyEntity(result).mentioned.id).toBe("28:abc-123");
  });

  it("accepts Bot Framework IDs with non-hex payloads (29:xxx)", () => {
    const result = parseMentions("@[Bot](29:08q2j2o3jc09au90eucae)");
    expect(requireOnlyEntity(result).mentioned.id).toBe("29:08q2j2o3jc09au90eucae");
  });

  it("accepts org-scoped IDs with extra segments (8:orgid:...)", () => {
    const result = parseMentions("@[User](8:orgid:2d8c2d2c-1111-2222-3333-444444444444)");
    expect(requireOnlyEntity(result).mentioned.id).toBe(
      "8:orgid:2d8c2d2c-1111-2222-3333-444444444444",
    );
  });

  it("accepts AAD object IDs (UUIDs)", () => {
    const result = parseMentions("@[User](a1b2c3d4-e5f6-7890-abcd-ef1234567890)");
    expect(requireOnlyEntity(result).mentioned.id).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("rejects non-ID strings as mention targets", () => {
    const result = parseMentions("See @[docs](https://example.com) for details");
    expect(result.entities).toHaveLength(0);
    // Original text preserved
    expect(result.text).toBe("See @[docs](https://example.com) for details");
  });
});

describe("buildActivity mention markup — jsdom structural oracle", () => {
  // Drive the full buildActivity → parseMentions call chain and verify
  // the resulting activity.text with an independent DOM parser (jsdom).
  // This proves that Teams' XML mention parser would see exactly one <at>
  // element with the correct textContent and no injected child nodes.

  it("produces exactly one well-formed <at> for a name with angle brackets and ampersand", async () => {
    const activity = await buildActivity({ text: "@[Alice <Admin> & Bob](28:abc-00001)" }, {});
    const s = parseAtStructure(activity.text as string);

    expect(s.atCount).toBe(1);
    expect(s.nestedAt).toBe(0);
    expect(s.hasInjectedChild).toBe(false);
    expect(s.textContent).toBe("Alice <Admin> & Bob");

    // entity.text must be a literal substring of activity.text (Teams requirement)
    const entities = activity.entities as Array<{ type: string; text: string }>;
    const mention = entities.find((e) => e.type === "mention");
    expect(activity.text as string).toContain(mention!.text);
  });

  it("produces exactly one <at> and blocks nested <at> injection", async () => {
    const activity = await buildActivity({ text: "@[<at>Eve</at>](28:abc-00002)" }, {});
    const s = parseAtStructure(activity.text as string);

    expect(s.atCount).toBe(1);
    expect(s.nestedAt).toBe(0);
    expect(s.hasInjectedChild).toBe(false);
    // The raw name is preserved in entity.mentioned.name
    const entities = activity.entities as Array<{ type: string; mentioned: { name: string } }>;
    const mention = entities.find((e) => e.type === "mention");
    expect(mention!.mentioned.name).toBe("<at>Eve</at>");
  });

  it("negative control — pre-fix interpolation breaks <at> structure", () => {
    // Demonstrate that raw interpolation (the bug) produces a corrupted DOM:
    // injected child elements and wrong textContent.
    const rawTag = `<at>Alice <Admin> & Bob</at>`;
    const s = parseAtStructure(rawTag);
    // The <Admin> element is parsed as a child node inside <at>
    expect(s.hasInjectedChild).toBe(true);
    // textContent skips the injected child's tag name so the name is truncated
    expect(s.textContent).not.toBe("Alice <Admin> & Bob");

    const rawNestedTag = `<at><at>Eve</at></at>`;
    const sn = parseAtStructure(rawNestedTag);
    expect(sn.nestedAt).toBeGreaterThan(0);
  });
});

// Drive the full sendMSTeamsMessages entry point so the escaped mention payload
// crosses a genuine HTTP boundary (JSON.stringify -> loopback TCP -> JSON.parse)
// into a fake Teams connector, then read the wire body back. This exercises the
// real production send stack (buildActivity -> sendMSTeamsActivityWithReference ->
// buildSdkConversationReference incl. serviceUrl allowlist validation -> merge ->
// activities.create) rather than a parser call in isolation, so it proves the
// escaping still holds after serialization and transport, not just at build time.
async function captureWireActivity(inputText: string): Promise<{
  text: string;
  entities: Array<{ type?: string; text?: string; mentioned?: { name?: string } }>;
}> {
  let captured: { text: string; entities?: unknown[] } | undefined;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      captured = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "srv-generated-id" }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  // A structural fake of `app.api` whose create() performs a real HTTP POST to the
  // loopback server. Everything upstream of this call runs as real production code.
  const post = (activity: unknown) =>
    new Promise<{ id?: string }>((resolve, reject) => {
      const payload = JSON.stringify(activity);
      const clientReq = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/v3/conversations/x/activities",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => resolve(JSON.parse(body)));
        },
      );
      clientReq.on("error", reject);
      clientReq.end(payload);
    });

  const app = {
    api: {
      serviceUrl: "https://smba.trafficmanager.net",
      conversations: {
        activities: () => ({
          create: post,
          createTargeted: post,
          update: (_id: string, activity: unknown) => post(activity),
          delete: async () => ({}),
        }),
      },
    },
  } as unknown as Parameters<typeof sendMSTeamsMessages>[0]["app"];

  const conversationRef = {
    activityId: "1:activity",
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net",
    agent: { id: "28:bot-app-id", name: "bot", role: "bot" },
    user: { id: "29:user-id", name: "user" },
    conversation: { id: "19:conv-id", conversationType: "personal", tenantId: "tenant-1" },
    tenantId: "tenant-1",
  } as unknown as Parameters<typeof sendMSTeamsMessages>[0]["conversationRef"];

  try {
    await sendMSTeamsMessages({
      replyStyle: "top-level",
      app,
      appId: "28:bot-app-id",
      conversationRef,
      messages: [{ text: inputText }] as unknown as Parameters<
        typeof sendMSTeamsMessages
      >[0]["messages"],
      retry: false,
    });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  if (!captured) {
    throw new Error("expected the send stack to POST an activity to the fake connector");
  }
  return { text: captured.text, entities: (captured.entities ?? []) as never };
}

describe("sendMSTeamsMessages wire capture — real HTTP send stack", () => {
  it("escaped mention survives the real send stack over HTTP as exactly one <at>", async () => {
    const wire = await captureWireActivity("@[Alice <Admin> & Bob](28:abc-00001)");
    const s = parseAtStructure(wire.text);

    expect(s.atCount).toBe(1);
    expect(s.nestedAt).toBe(0);
    expect(s.hasInjectedChild).toBe(false);
    expect(s.textContent).toBe("Alice <Admin> & Bob");

    // Teams requires entity.text to be a literal substring of the wire activity.text.
    const mention = wire.entities.find((e) => e.type === "mention");
    expect(mention?.text).toBeDefined();
    expect(wire.text).toContain(mention!.text!);
    expect(mention!.mentioned?.name).toBe("Alice <Admin> & Bob");
  });

  it("blocks nested <at> injection over the real send stack", async () => {
    const wire = await captureWireActivity("@[<at>Eve</at>](28:abc-00002)");
    const s = parseAtStructure(wire.text);

    expect(s.atCount).toBe(1);
    expect(s.nestedAt).toBe(0);
    expect(s.hasInjectedChild).toBe(false);
    const mention = wire.entities.find((e) => e.type === "mention");
    expect(mention!.mentioned?.name).toBe("<at>Eve</at>");
  });

  it("passes a clean display name through the send stack unchanged", async () => {
    const wire = await captureWireActivity("@[Normal Name](28:abc-00003)");
    const s = parseAtStructure(wire.text);

    expect(s.atCount).toBe(1);
    expect(s.nestedAt).toBe(0);
    expect(s.hasInjectedChild).toBe(false);
    expect(s.textContent).toBe("Normal Name");
  });
});
