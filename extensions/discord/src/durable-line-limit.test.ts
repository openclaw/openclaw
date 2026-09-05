// Exercises durable Discord line-limit resolution through the real local HTTP transport boundary.
import { ChannelType } from "discord-api-types/v10";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeAll, describe, expect, it } from "vitest";
import { createDiscordLoopbackRest } from "./send.test-harness.js";

let discordPlugin: typeof import("./channel.js").discordPlugin;
let sendMessageDiscord: typeof import("./send.js").sendMessageDiscord;

const twentyLineText = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n");

beforeAll(async () => {
  ({ discordPlugin } = await import("./channel.js"));
  ({ sendMessageDiscord } = await import("./send.js"));
});

async function runDurableLineLimitScenario(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  structured?: boolean;
  formatting?: { maxLinesPerMessage?: number };
}) {
  let messageCount = 0;
  const loopback = await createDiscordLoopbackRest({
    respond: ({ method }) =>
      method === "GET"
        ? { id: "789", type: ChannelType.GuildText }
        : { id: `message-${++messageCount}`, channel_id: "789" },
  });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: discordPlugin,
      },
    ]),
  );
  try {
    const result = await sendDurableMessageBatch({
      cfg: params.cfg,
      channel: "discord",
      to: "channel:789",
      accountId: params.accountId,
      payloads: [
        {
          text: twentyLineText,
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
    const chunks = loopback.requests
      .filter((request) => request.method === "POST")
      .map((request) => JSON.parse(request.body) as { content?: string })
      .map((body) => body.content ?? "");
    return { chunks, result };
  } finally {
    await loopback.close();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  }
}

describe("durable Discord configured line limits", () => {
  it("uses the selected account limit for plain durable text", async () => {
    const { chunks, result } = await runDurableLineLimitScenario({
      cfg: {
        channels: {
          discord: {
            maxLinesPerMessage: 10,
            accounts: { work: { token: "fixture-token", maxLinesPerMessage: 50 } },
          },
        },
      },
      accountId: "work",
    });

    expect(result.status).toBe("sent");
    expect(chunks).toEqual([twentyLineText]);
  });

  it("uses the selected account limit for structured payload fallback text", async () => {
    const { chunks, result } = await runDurableLineLimitScenario({
      cfg: {
        channels: {
          discord: {
            maxLinesPerMessage: 10,
            accounts: { work: { token: "fixture-token", maxLinesPerMessage: 50 } },
          },
        },
      },
      accountId: "work",
      structured: true,
    });

    expect(result.status).toBe("sent");
    expect(chunks).toEqual([twentyLineText]);
  });

  it("keeps the 17-line Discord default when no override is configured", async () => {
    const { chunks } = await runDurableLineLimitScenario({
      cfg: { channels: { discord: { token: "fixture-token" } } },
    });

    expect(chunks).toEqual([
      Array.from({ length: 17 }, (_, index) => `line-${index + 1}`).join("\n"),
      ["line-18", "line-19", "line-20"].join("\n"),
    ]);
  });

  it("keeps explicit per-send formatting ahead of configured limits", async () => {
    const { chunks } = await runDurableLineLimitScenario({
      cfg: { channels: { discord: { token: "fixture-token", maxLinesPerMessage: 50 } } },
      formatting: { maxLinesPerMessage: 5 },
    });

    expect(chunks.map((chunk) => chunk.split("\n").length)).toEqual([5, 5, 5, 5]);
    expect(chunks.join("\n")).toBe(twentyLineText);
  });
});
