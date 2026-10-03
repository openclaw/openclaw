import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  origin: "",
  requests: [] as string[],
}));

// Only OAuth and the external HTTP endpoint are substituted. The action,
// authorization, lazy runtime, Graph reader, and reaction decoder remain real.
vi.mock("./graph.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./graph.js")>()),
  resolveGraphToken: async () => "synthetic-graph-token",
}));
vi.mock("../runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime-api.js")>()),
  fetchWithSsrFGuard: async ({ url, init }: { url: string; init?: RequestInit }) => {
    const target = new URL(url);
    if (target.origin !== "https://graph.microsoft.com") {
      throw new Error("Unexpected provider origin in reaction proof");
    }
    transport.requests.push(`${target.pathname}${target.search}`);
    const response = await fetch(`${transport.origin}${target.pathname}${target.search}`, init);
    return { response, finalUrl: url, release: async () => undefined };
  },
}));

import { msteamsPlugin } from "./channel.js";

const chatId = "19:reaction-proof@thread.v2";
const target = `conversation:${chatId}`;
const messageId = "message-1";
type ActionContext = Parameters<
  NonNullable<NonNullable<typeof msteamsPlugin.actions>["handleAction"]>
>[0];

function readReactions(to = target) {
  const handleAction = msteamsPlugin.actions?.handleAction;
  if (!handleAction) {
    throw new Error("The registered Teams reaction action is unavailable");
  }
  return handleAction({
    action: "reactions",
    channel: "msteams",
    accountId: "default",
    requesterAccountId: "default",
    cfg: { channels: { msteams: { groupPolicy: "allowlist", dmPolicy: "pairing" } } },
    params: { to, messageId },
    toolContext: {
      currentChannelProvider: "msteams",
      currentChannelId: target,
      currentChatType: "direct",
    },
  } satisfies ActionContext);
}

describe("Teams reaction identity through the registered action", () => {
  let server: Server;
  let response: unknown;
  const receivedPaths: string[] = [];

  beforeEach(async () => {
    receivedPaths.length = 0;
    transport.requests.length = 0;
    response = { id: messageId, reactions: [] };
    server = createServer((request, reply) => {
      receivedPaths.push(request.url ?? "");
      reply.writeHead(200, { "Content-Type": "application/json" });
      reply.end(JSON.stringify(response));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("The reaction fixture did not bind a TCP port");
    }
    transport.origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  });

  it("returns users from Graph identity sets without losing anonymous counts", async () => {
    // chatMessageReaction.user is an identity set; the reactor is its user property.
    response = {
      id: messageId,
      reactions: [
        {
          reactionType: "like",
          user: { application: null, user: { id: "user-1", displayName: "Alice" } },
        },
        { reactionType: "like", user: { user: { id: "user-2", displayName: null } } },
        { reactionType: "like", user: { user: { displayName: "Deleted user" } } },
        { reactionType: "like", user: null },
        { reactionType: "heart", user: { user: { id: "user-3", displayName: "Carol" } } },
      ],
    };
    const result = await readReactions();
    const expected = {
      ok: true,
      channel: "msteams",
      action: "reactions",
      reactions: [
        {
          reactionType: "like",
          name: "like",
          emoji: "👍",
          count: 4,
          users: [{ id: "user-1", displayName: "Alice" }, { id: "user-2" }],
        },
        {
          reactionType: "heart",
          name: "heart",
          emoji: "❤️",
          count: 1,
          users: [{ id: "user-3", displayName: "Carol" }],
        },
      ],
    };
    const text = result.content.find((item) => item.type === "text");
    expect(text?.type).toBe("text");
    if (text?.type !== "text") {
      throw new Error("Reaction action returned no text");
    }
    console.info("TEAMS_REACTION_PROOF", text.text);
    expect(transport.requests).toEqual([
      `/v1.0/chats/${encodeURIComponent(chatId)}/messages/${messageId}`,
    ]);
    expect(receivedPaths).toEqual(transport.requests);
    expect(JSON.parse(text.text)).toEqual(expected);
    expect(result.details).toEqual(expected);
  });

  it("returns an empty reaction list for a message without reactions", async () => {
    response = { id: messageId };
    await expect(readReactions()).resolves.toMatchObject({ details: { ok: true, reactions: [] } });
    expect(receivedPaths).toHaveLength(1);
  });

  it("does not fetch another conversation outside the current allowed target", async () => {
    await expect(readReactions("conversation:19:other@thread.v2")).rejects.toThrow("not allowed");
    expect(transport.requests).toEqual([]);
    expect(receivedPaths).toEqual([]);
  });
});
