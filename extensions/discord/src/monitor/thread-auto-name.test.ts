import type { GatewayMessageCreateDispatchData as APIMessage } from "discord-api-types/v10";
import { GuildMemberFlags, PermissionFlagsBits } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "../internal/discord.js";
import { createDiscordLivePolicyReader } from "./live-policy.js";
import { resolveDiscordThreadAutoNameThreshold } from "./thread-auto-name.config.js";
import { DiscordThreadAutoNamer, sanitizeDiscordAutoNameTitle } from "./thread-auto-name.js";
import {
  DiscordAutoNameMessageCreateListener,
  DiscordAutoNameThreadCreateListener,
} from "./thread-auto-name.listeners.js";
import { createNoopThreadBindingManager } from "./thread-bindings.session-adapter.js";

// Fixed model-boundary response; admission, title assembly, REST serialization,
// permission evaluation, and worker-backed persistence all execute production code.
const model = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/reply-dispatch-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/reply-dispatch-runtime")>()),
  generateConversationLabel: model,
}));
vi.mock("../runtime.js", async (original) => ({
  ...(await original<typeof import("../runtime.js")>()),
  getDiscordRuntime: () => ({
    state: {
      openKeyedStoreV2: <T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreV2ForTests<T>("discord", options, { assertCurrent() {} }),
    },
  }),
}));

const GUILD = "123456789012345678";
const PARENT = "223456789012345678";
const BOT = "323456789012345678";
const ALLOWED = "423456789012345678";
const DENIED = "523456789012345678";
const ROLE = "623456789012345678";
const EPOCH = 1_420_070_400_000;
function snowflake(at: number, sequence = 0): string {
  return ((BigInt(at - EPOCH) << 22n) + BigInt(sequence)).toString();
}
function config(threshold: number | boolean = 1): OpenClawConfig {
  return {
    channels: {
      discord: {
        token: "synthetic-discord-token",
        groupPolicy: "allowlist",
        thread: { autoName: threshold },
        guilds: { [GUILD]: { users: [ALLOWED], channels: { [PARENT]: {} } } },
      },
    },
  };
}

function fixture(
  initial = config(),
  options: { queueRequests?: boolean; patchResponse?: () => Response } = {},
) {
  let cfg = initial;
  let now = Date.now();
  let botPermission = true;
  let currentRoles = [ROLE];
  let channelName = "Untitled";
  let patchStatus = 200;
  const patches: Array<{ path: string; body: unknown }> = [];
  const client = new Client(
    {
      clientId: BOT,
      token: "synthetic-discord-token",
      requestOptions: {
        queueRequests: options.queueRequests ?? false,
        fetch: async (input, init) => {
          const path = new URL(
            input instanceof Request ? input.url : input instanceof URL ? input.href : input,
          ).pathname.replace(/^\/api\/v\d+/, "");
          if (init?.method === "PATCH") {
            if (typeof init.body !== "string") {
              throw new Error("Expected serialized JSON PATCH body");
            }
            patches.push({ path, body: JSON.parse(init.body) });
            if (options.patchResponse) {
              return options.patchResponse();
            }
            return Response.json(
              patchStatus === 200 ? { name: "Release planning" } : { message: "Denied" },
              { status: patchStatus },
            );
          }
          if (path === `/guilds/${GUILD}`) {
            return Response.json({
              id: GUILD,
              name: "Synthetic guild",
              owner_id: "owner",
              roles: [
                {
                  id: GUILD,
                  permissions: (botPermission ? PermissionFlagsBits.ManageThreads : 0n).toString(),
                },
              ],
            });
          }
          if (path.startsWith(`/guilds/${GUILD}/members/`)) {
            return Response.json({
              roles: path.endsWith(BOT) ? [] : currentRoles,
            });
          }
          if (path === `/channels/${PARENT}`) {
            return Response.json({
              id: PARENT,
              guild_id: GUILD,
              type: 0,
              name: "planning",
              permission_overwrites: [],
            });
          }
          if (path.startsWith("/channels/")) {
            return Response.json({
              id: path.slice("/channels/".length),
              guild_id: GUILD,
              parent_id: PARENT,
              type: 11,
              name: channelName,
              permission_overwrites: [],
            });
          }
          throw new Error(`Unexpected fixture REST path: ${path}`);
        },
      },
    },
    {},
  );
  const readPolicy = createDiscordLivePolicyReader({
    cfg,
    readConfig: () => cfg,
    accountId: "default",
    token: "synthetic-discord-token",
    discordRestFetch: client.rest.options.fetch,
    resolvedAllowlist: { guildEntries: cfg.channels?.discord?.guilds, allowFrom: [] },
  });
  const makeNamer = () =>
    new DiscordThreadAutoNamer({
      cfg,
      readPolicy,
      accountId: "default",
      botUserId: BOT,
      nowMs: () => now,
    });
  const namer = makeNamer();
  function thread(n = 0, createdAt = now) {
    const id = snowflake(createdAt, n);
    namer.onThreadCreate({
      id,
      guild_id: GUILD,
      parent_id: PARENT,
      name: "Untitled",
      newly_created: true,
    });
    return id;
  }
  function message(
    threadId: string,
    n = 1,
    authorId = ALLOWED,
    content = "Plan the release",
  ): APIMessage {
    return {
      id: snowflake(now, 100 + n),
      channel_id: threadId,
      guild_id: GUILD,
      type: 0,
      content,
      author: {
        id: authorId,
        username: "synthetic-user",
        discriminator: "0",
        avatar: null,
        global_name: null,
        bot: authorId === BOT,
      },
      member: {
        roles: [ROLE],
        joined_at: new Date(now).toISOString(),
        deaf: false,
        mute: false,
        flags: GuildMemberFlags.CompletedOnboarding,
      },
      attachments: [],
      embeds: [],
      timestamp: new Date(now).toISOString(),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      pinned: false,
    };
  }
  return {
    namer,
    makeNamer,
    client,
    thread,
    message,
    patches,
    get cfg() {
      return cfg;
    },
    get now() {
      return now;
    },
    update: (next: OpenClawConfig) => {
      cfg = next;
    },
    advance: (ms: number) => {
      now += ms;
    },
    revokePermission: () => {
      botPermission = false;
    },
    revokeRole: () => {
      currentRoles = [];
    },
    rename: () => {
      channelName = "Manual title";
    },
    rejectPatch: () => {
      patchStatus = 403;
    },
  };
}

async function isolated(run: () => Promise<void>) {
  await withOpenClawTestState({ label: "discord-auto-name-boundary" }, async () => {
    const threadBindings = createNoopThreadBindingManager("default");
    try {
      await run();
    } finally {
      await threadBindings.stop();
      resetPluginStateStoreForTests();
    }
  });
}
beforeEach(() => {
  model.mockReset().mockResolvedValue("Release planning");
});

describe("Discord thread naming through production admission and effects", () => {
  it("resolves thresholds and account overrides and sanitizes a bounded title", () => {
    expect(resolveDiscordThreadAutoNameThreshold(config(false), "default")).toBe(0);
    expect(resolveDiscordThreadAutoNameThreshold(config(true), "default")).toBe(5);
    const cfg = config(3);
    cfg.channels!.discord!.accounts = { work: { thread: { autoName: 8 } } };
    expect(resolveDiscordThreadAutoNameThreshold(cfg, "work")).toBe(8);
    expect(sanitizeDiscordAutoNameTitle("**Deploy**\n<@123> `plan`\0 #now")).toBe(
      "Deploy plan now",
    );
    expect(sanitizeDiscordAutoNameTitle(`${"a".repeat(99)}😀tail`)).toBe("a".repeat(99));
  });

  it("admits a human then the agent, excludes denied text, and persists one attempt across reopen", async () =>
    isolated(async () => {
      const f = fixture(config(2));
      const id = f.thread();
      await f.namer.onMessage(f.message(id, 1, DENIED, "Private denied text"), f.client);
      expect(model).not.toHaveBeenCalled();
      expect(f.patches).toEqual([]);
      const first = f.message(id, 2);
      await f.namer.onMessage(first, f.client);
      await f.namer.onMessage(first, f.client);
      await f.namer.onMessage(f.message(id, 3, BOT, "Ship on Friday"), f.client);
      expect(model).toHaveBeenCalledTimes(1);
      expect(model.mock.calls[0]?.[0]?.userMessage).toBe(
        "Message:\nUser: Plan the release\nAgent: Ship on Friday",
      );
      expect(f.patches).toEqual([{ path: `/channels/${id}`, body: { name: "Release planning" } }]);
      resetPluginStateStoreForTests();
      const restarted = f.makeNamer();
      restarted.onThreadCreate({
        id,
        guild_id: GUILD,
        parent_id: PARENT,
        name: "Untitled",
        newly_created: true,
      });
      await restarted.onMessage(f.message(id, 4), f.client);
      expect(model).toHaveBeenCalledTimes(1);
      expect(f.patches).toHaveLength(1);
    }));

  it.each([21, 22])(
    "names at threshold %s after the admitted human leaves the transcript window",
    async (threshold) =>
      isolated(async () => {
        const f = fixture(config(threshold));
        const id = f.thread();
        await f.namer.onMessage(f.message(id, 1, ALLOWED, "Original human opener"), f.client);
        for (let n = 2; n < threshold; n += 1) {
          await f.namer.onMessage(f.message(id, n, BOT, `Release detail ${n}`), f.client);
        }
        expect(model).not.toHaveBeenCalled();
        expect(f.patches).toEqual([]);

        await f.namer.onMessage(
          f.message(id, threshold, BOT, `Release detail ${threshold}`),
          f.client,
        );
        expect(model).toHaveBeenCalledTimes(1);
        expect(model.mock.calls[0]?.[0]?.userMessage).toBe(
          `Message:\n${Array.from(
            { length: 20 },
            (_, index) => `Agent: Release detail ${threshold - 19 + index}`,
          ).join("\n")}`,
        );
        expect(f.patches).toEqual([
          { path: `/channels/${id}`, body: { name: "Release planning" } },
        ]);

        await f.namer.onMessage(f.message(id, threshold + 1, BOT), f.client);
        expect(model).toHaveBeenCalledTimes(1);
        expect(f.patches).toHaveLength(1);
      }),
  );

  it.each(["before model", "during model"])(
    "rejects human role revocation %s after the human leaves the transcript window",
    async (when) =>
      isolated(async () => {
        const cfg = config(22);
        cfg.channels!.discord!.guilds![GUILD]!.users = [];
        cfg.channels!.discord!.guilds![GUILD]!.roles = [ROLE];
        const f = fixture(cfg);
        const id = f.thread();
        await f.namer.onMessage(f.message(id, 1), f.client);
        for (let n = 2; n <= 21; n += 1) {
          await f.namer.onMessage(f.message(id, n, BOT, `Release detail ${n}`), f.client);
        }
        expect(model).not.toHaveBeenCalled();
        expect(f.patches).toEqual([]);

        if (when === "before model") {
          f.revokeRole();
        } else {
          model.mockImplementationOnce(async () => {
            f.revokeRole();
            return "Release planning";
          });
        }
        await f.namer.onMessage(f.message(id, 22, BOT, "Release detail 22"), f.client);
        expect(model).toHaveBeenCalledTimes(when === "before model" ? 0 : 1);
        expect(f.patches).toEqual([]);
      }),
  );

  it.each(["guild", "channel", "user", "role", "disabled", "action"])(
    "blocks %s denial before model and PATCH",
    async (kind) =>
      isolated(async () => {
        const cfg = config();
        const discord = cfg.channels!.discord!;
        if (kind === "guild") {
          discord.guilds = { "723456789012345678": { channels: { [PARENT]: {} } } };
          discord.groupPolicy = "open";
        }
        if (kind === "channel") {
          discord.guilds![GUILD]!.channels = { [PARENT]: { enabled: false } };
        }
        if (kind === "role") {
          discord.guilds![GUILD]!.users = [];
          discord.guilds![GUILD]!.roles = ["other-role"];
        }
        if (kind === "disabled") {
          discord.enabled = false;
        }
        if (kind === "action") {
          discord.actions = { channels: false };
        }
        const f = fixture(cfg);
        const id = f.thread();
        await f.namer.onMessage(f.message(id, 1, kind === "user" ? DENIED : ALLOWED), f.client);
        expect(model).not.toHaveBeenCalled();
        expect(f.patches).toEqual([]);
      }),
  );

  it.each(["policy", "threshold", "account", "action", "role", "permission", "manual", "stop"])(
    "rejects %s revocation during generation",
    async (kind) =>
      isolated(async () => {
        const cfg = config();
        if (kind === "role") {
          cfg.channels!.discord!.guilds![GUILD]!.users = [];
          cfg.channels!.discord!.guilds![GUILD]!.roles = [ROLE];
        }
        const f = fixture(cfg);
        const id = f.thread();
        model.mockImplementationOnce(async () => {
          if (kind === "policy") {
            f.update({
              channels: {
                discord: {
                  ...f.cfg.channels!.discord!,
                  guilds: { [GUILD]: { users: [DENIED], channels: { [PARENT]: {} } } },
                },
              },
            });
          }
          if (kind === "threshold") {
            f.update({
              channels: { discord: { ...f.cfg.channels!.discord!, thread: { autoName: false } } },
            });
          }
          if (kind === "account") {
            f.update({ channels: { discord: { ...f.cfg.channels!.discord!, enabled: false } } });
          }
          if (kind === "action") {
            f.update({
              channels: { discord: { ...f.cfg.channels!.discord!, actions: { channels: false } } },
            });
          }
          if (kind === "role") {
            f.revokeRole();
          }
          if (kind === "permission") {
            f.revokePermission();
          }
          if (kind === "manual") {
            f.rename();
          }
          if (kind === "stop") {
            f.namer.stop();
          }
          return "Release planning";
        });
        await f.namer.onMessage(f.message(id), f.client);
        expect(model).toHaveBeenCalledTimes(1);
        expect(f.patches).toEqual([]);
      }),
  );

  it.each(["allowed", "threshold", "action", "stop"])(
    "revalidates %s naming authority before a queued rate-limit retry",
    async (kind) =>
      isolated(async () => {
        const firstPatch = createDeferred<void>();
        let attempts = 0;
        const f = fixture(config(), {
          queueRequests: true,
          patchResponse: () => {
            if (++attempts > 1) {
              return Response.json({ name: "Release planning" });
            }
            vi.useFakeTimers();
            if (kind === "threshold") {
              f.update({
                channels: { discord: { ...f.cfg.channels!.discord!, thread: { autoName: false } } },
              });
            }
            if (kind === "action") {
              f.update({
                channels: {
                  discord: { ...f.cfg.channels!.discord!, actions: { channels: false } },
                },
              });
            }
            if (kind === "stop") {
              f.namer.stop();
            }
            firstPatch.resolve();
            return Response.json({ retry_after: 0.001 }, { status: 429 });
          },
        });
        const id = f.thread();
        const pending = f.namer.onMessage(f.message(id), f.client);
        try {
          await Promise.race([firstPatch.promise, pending]);
          expect(attempts).toBe(1);
          await vi.advanceTimersByTimeAsync(2);
          await pending;
          expect(model).toHaveBeenCalledTimes(1);
          expect(attempts).toBe(kind === "allowed" ? 2 : 1);
          expect(f.patches).toEqual(
            Array.from({ length: kind === "allowed" ? 2 : 1 }, () => ({
              path: `/channels/${id}`,
              body: { name: "Release planning" },
            })),
          );
        } finally {
          vi.useRealTimers();
          f.namer.stop();
        }
      }),
  );

  it("keeps the parent budget across restart and rejects expired creation events", async () =>
    isolated(async () => {
      const f = fixture();
      for (const n of [1, 2]) {
        const id = f.thread(n);
        await f.namer.onMessage(f.message(id, n), f.client);
      }
      resetPluginStateStoreForTests();
      const restarted = f.makeNamer();
      const third = snowflake(f.now, 3);
      restarted.onThreadCreate({
        id: third,
        guild_id: GUILD,
        parent_id: PARENT,
        name: "Untitled",
        newly_created: true,
      });
      await restarted.onMessage(f.message(third, 3), f.client);
      expect(f.patches).toHaveLength(2);
      expect(model).toHaveBeenCalledTimes(2);
      const old = f.thread(4, f.now - 24 * 60 * 60_000 - 1);
      await f.namer.onMessage(f.message(old, 4), f.client);
      expect(f.patches).toHaveLength(2);
    }));

  it("handles actual Gateway dispatch with production listeners and serialized Discord PATCH", async () =>
    isolated(async () => {
      const f = fixture();
      f.client.listeners.push(
        new DiscordAutoNameThreadCreateListener(f.namer),
        new DiscordAutoNameMessageCreateListener(f.namer),
      );
      const id = snowflake(f.now - 1);
      await f.client.dispatchGatewayEvent("THREAD_CREATE", {
        id,
        guild_id: GUILD,
        parent_id: PARENT,
        name: "Untitled",
        type: 11,
        newly_created: true,
      });
      const message = f.message(id);
      await f.client.dispatchGatewayEvent("MESSAGE_CREATE", message);
      // A duplicate queued message joins completion through the production API and must not count twice.
      await f.namer.onMessage(message, f.client);
      expect(f.patches).toEqual([{ path: `/channels/${id}`, body: { name: "Release planning" } }]);
    }));

  it("does not let agent-only traffic trigger naming, and keeps a rejected PATCH one-time", async () =>
    isolated(async () => {
      const f = fixture();
      const id = f.thread();
      await f.namer.onMessage(f.message(id, 1, BOT), f.client);
      expect(model).not.toHaveBeenCalled();
      f.rejectPatch();
      await f.namer.onMessage(f.message(id, 2), f.client);
      await f.namer.onMessage(f.message(id, 3), f.client);
      expect(f.patches).toHaveLength(1);
    }));
  it("uses thread creation metadata when the starter message is older than the naming window", async () =>
    isolated(async () => {
      const f = fixture();
      const id = snowflake(f.now - 48 * 60 * 60_000);
      f.namer.onThreadCreate({
        id,
        guild_id: GUILD,
        parent_id: PARENT,
        name: "Untitled",
        newly_created: true,
        thread_metadata: { create_timestamp: new Date(f.now).toISOString() },
      });
      await f.namer.onMessage(f.message(id), f.client);
      expect(f.patches).toEqual([{ path: `/channels/${id}`, body: { name: "Release planning" } }]);
    }));

  it("cannot restart naming from events delivered after shutdown", async () =>
    isolated(async () => {
      const f = fixture();
      f.namer.stop();
      const id = f.thread();
      await f.namer.onMessage(f.message(id), f.client);
      expect(model).not.toHaveBeenCalled();
      expect(f.patches).toEqual([]);
    }));

  it("cancels an overloaded thread while admission is waiting on Discord", async () =>
    isolated(async () => {
      const f = fixture(config(100));
      const id = f.thread();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fetchGuild = f.client.fetchGuild.bind(f.client);
      f.client.fetchGuild = async (guildId) => {
        await gate;
        return fetchGuild(guildId);
      };
      const pending = Array.from({ length: 30 }, (_, i) =>
        f.namer.onMessage(f.message(id, i), f.client),
      );
      release();
      await Promise.all(pending.filter((work): work is Promise<void> => work !== undefined));
      expect(f.namer.onMessage(f.message(id, 50), f.client)).toBeUndefined();
      expect(model).not.toHaveBeenCalled();
      expect(f.patches).toEqual([]);
    }));
});
