import { ChannelType } from "discord-api-types/v10";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as threadBindings from "./monitor/thread-bindings.js";
import { createDiscordLoopbackRest } from "./send.test-harness.js";

let discordPlugin: typeof import("./channel.js").discordPlugin;
let sendMessageDiscord: typeof import("./send.js").sendMessageDiscord;

const twentyLineText = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n");
const persona = { name: "Fixture persona", avatarUrl: "https://example.invalid/avatar.png" };

beforeAll(async () => {
  ({ discordPlugin } = await import("./channel.js"));
  ({ sendMessageDiscord } = await import("./send.js"));
});

function lineLimitConfig(root: number, account?: number): OpenClawConfig {
  const work = {
    token: "fixture-token",
    ...(account === undefined ? {} : { maxLinesPerMessage: account }),
  };
  return { channels: { discord: { maxLinesPerMessage: root, accounts: { work } } } };
}

type PostedMessage = { content?: string; message_reference?: { message_id?: string } };

async function runDurableLineLimitScenario(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  structured?: boolean;
  webhook?: boolean;
  text?: string;
  replyToIdSource?: "implicit" | "explicit";
  replyToMode?: "first" | "all";
  formatting?: Parameters<typeof sendDurableMessageBatch>[0]["formatting"];
}) {
  const apiUrlBefore = process.env.DISCORD_API_URL;
  vi.stubEnv("DISCORD_API_URL", undefined);
  let messageCount = 0;
  const replyToId = params.webhook && !params.replyToIdSource ? undefined : "fixture-reply";
  const loopback = await createDiscordLoopbackRest({
    respond: ({ method }) =>
      method === "GET"
        ? { id: "789", type: ChannelType.GuildText }
        : { id: `message-${++messageCount}`, channel_id: "789" },
  });
  const manager = threadBindings.createNoopThreadBindingManager(params.accountId);
  const binding = {
    accountId: params.accountId ?? "default",
    channelId: "789",
    threadId: "789",
    targetKind: "subagent" as const,
    targetSessionKey: "agent:main:subagent:fixture",
    agentId: "main",
    webhookId: "fixture-webhook",
    webhookToken: "fixture-webhook-token",
    boundBy: "fixture",
    boundAt: 1,
    lastActivityAt: 1,
  };
  const bindingSpy = vi
    .spyOn(threadBindings, "getThreadBindingManager")
    .mockReturnValue(params.webhook ? { ...manager, getByThreadId: () => binding } : null);
  const baseUrl = expectDefined(loopback.rest.options.baseUrl, "loopback base URL");
  vi.stubEnv("DISCORD_API_URL", `${baseUrl}/api/v10`);
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", source: "test", plugin: discordPlugin }]),
  );
  try {
    const result = await sendDurableMessageBatch({
      cfg: params.cfg,
      channel: "discord",
      to: "channel:789",
      accountId: params.accountId,
      threadId: params.webhook ? "789" : undefined,
      identity: params.webhook ? { ...persona } : undefined,
      replyToId,
      replyToMode: params.replyToMode,
      payloads: [
        {
          text: params.text ?? twentyLineText,
          ...(params.replyToIdSource === "explicit" ? { replyToId: "fixture-reply" } : {}),
          ...(params.structured
            ? {
                channelData: {
                  execApproval: { approvalId: "proof-approval", approvalSlug: "proof-approval" },
                },
              }
            : {}),
        },
      ],
      formatting: params.formatting,
      deps: {
        discord: async (...[target, text, options]: Parameters<typeof sendMessageDiscord>) =>
          await sendMessageDiscord(target, text, {
            ...options,
            rest: loopback.rest,
            token: "fixture-token",
          }),
      },
      skipQueue: true,
    });
    expect(result.status).toBe("sent");
    const posts = loopback.requests.filter((request) => request.method === "POST");
    const posted = posts.map((request) => JSON.parse(request.body) as PostedMessage);
    const chunks = posted.map((body) => body.content ?? "");
    const replies = posted.map((body) => body.message_reference?.message_id);
    if (params.webhook && !replyToId) {
      expect(posts.every((request) => request.path?.includes("/webhooks/fixture-webhook/"))).toBe(
        true,
      );
      expect(posts.every((request) => request.path?.includes("thread_id=789"))).toBe(true);
      for (const body of posted) {
        expect(body).toMatchObject({ username: persona.name, avatar_url: persona.avatarUrl });
      }
    } else {
      expect(posts.every((request) => request.path?.includes("/channels/789/messages"))).toBe(true);
    }
    return { chunks, replies };
  } finally {
    vi.stubEnv("DISCORD_API_URL", apiUrlBefore);
    bindingSpy.mockRestore();
    await loopback.close();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  }
}

it("uses the selected account limit for structured payload fallback text", async () => {
  const { chunks } = await runDurableLineLimitScenario({
    cfg: lineLimitConfig(10, 50),
    accountId: "work",
    structured: true,
  });

  expect(chunks).toEqual([twentyLineText]);
});

describe.each([false, true])("durable Discord transport webhook=%s", (webhook) => {
  it("reapplies the explicit character limit after expanding mentions", async () => {
    const userId = "123456789012345678";
    const { chunks, replies } = await runDurableLineLimitScenario({
      cfg: { channels: { discord: { token: "fixture-token", mentionAliases: { op: userId } } } },
      webhook,
      text: Array.from({ length: 30 }, () => "@op").join(" "),
      replyToMode: "first",
      formatting: { textLimit: 500 },
    });

    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
    expect(chunks.join(""), JSON.stringify(chunks)).toBe(
      Array.from({ length: 30 }, () => `<@${userId}>`).join(" "),
    );
    expect(replies).toEqual(
      chunks.map((_, index) => (!webhook && index === 0 ? "fixture-reply" : undefined)),
    );
  });

  it("preserves fenced code and character limits through durable delivery", async () => {
    const body = Array.from({ length: 20 }, (_, index) => `row-${index}: ${"x".repeat(130)}`).join(
      "\n",
    );
    const { chunks } = await runDurableLineLimitScenario({
      cfg: { channels: { discord: { token: "fixture-token", maxLinesPerMessage: 8 } } },
      webhook,
      text: `\`\`\`text\n${body}\n\`\`\``,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.every((chunk) => chunk.startsWith("```text\n") && chunk.endsWith("\n```"))).toBe(
      true,
    );
    let offset = 0;
    for (const chunk of chunks) {
      const content = chunk.split("\n").slice(1, -1).join("\n");
      expect(body.slice(offset, offset + content.length)).toBe(content);
      offset += content.length;
      // A character boundary can split inside a source line; only consume an original newline.
      if (body[offset] === "\n") {
        offset += 1;
      }
    }
    expect(offset).toBe(body.length);
  });
});

it.each([
  ["root limit", false, 10, undefined, undefined, [10, 10]],
  ["account wins", true, 5, 50, undefined, [20]],
  ["explicit smaller", false, 10, 50, 5, [5, 5, 5, 5]],
  ["explicit smaller", true, 10, 50, 5, [5, 5, 5, 5]],
  ["explicit larger", false, 5, 10, 50, [20]],
  ["explicit larger", true, 5, 10, 50, [20]],
] as const)(
  "preserves %s at the HTTP boundary (webhook=%s)",
  async (_name, webhook, root, account, explicit, counts) => {
    const { chunks } = await runDurableLineLimitScenario({
      cfg: lineLimitConfig(root, account),
      accountId: "work",
      webhook,
      formatting: explicit === undefined ? undefined : { maxLinesPerMessage: explicit },
    });
    expect(chunks.map((chunk) => chunk.split("\n").length)).toEqual(counts);
    expect(chunks.join("\n")).toBe(twentyLineText);
  },
);

it.each([
  { replyToIdSource: "explicit", replyToMode: "first", webhook: true },
  { replyToIdSource: "implicit", replyToMode: "all", webhook: false },
] as const)(
  "preserves $replyToIdSource $replyToMode-mode replies across physical chunks",
  async ({ replyToIdSource, replyToMode, webhook }) => {
    const { chunks, replies } = await runDurableLineLimitScenario({
      cfg: { channels: { discord: { token: "fixture-token" } } },
      webhook,
      replyToIdSource,
      replyToMode,
    });
    expect(chunks.map((chunk) => chunk.split("\n").length)).toEqual([17, 3]);
    expect(replies).toEqual(["fixture-reply", "fixture-reply"]);
  },
);
