import fs from "node:fs/promises";
import path from "node:path";
import { ChannelType, type GatewayThreadDeleteDispatchData } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getSessionEntry,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { withEnvAsync, withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { DiscordThreadDeleteListener } from "./listeners.js";

const THREAD_ID = "112233445566778899";
const OTHER_THREAD_ID = "998877665544332211";

describe("DiscordThreadDeleteListener session-store integration", () => {
  it("deletes matching sessions from every configured agent store", async () => {
    await withStateDirEnv("openclaw-discord-thread-delete-", async ({ tempRoot, stateDir }) => {
      // macOS exposes os.tmpdir() through /var while SQLite resolves /private/var.
      await withEnvAsync({ OPENCLAW_STATE_DIR: await fs.realpath(stateDir) }, async () => {
        const cfg = {
          session: { store: path.join(await fs.realpath(tempRoot), "shared", "sessions.json") },
          agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        } satisfies OpenClawConfig;
        const session = (
          agentId: string,
          suffix: string,
          sessionId: string,
          updatedAt: number,
        ) => ({
          agentId,
          sessionKey: `agent:${agentId}:discord:channel:${suffix}`,
          storePath: resolveStorePath(cfg.session.store, { agentId }),
          entry: { sessionId, updatedAt },
        });
        const main = session("main", THREAD_ID, "main-thread-session", 1_000);
        const work = session("work", `parent:thread:${THREAD_ID}`, "work-thread-session", 2_000);
        const survivor = session("main", OTHER_THREAD_ID, "main-survivor-session", 3_000);
        for (const entry of [main, work, survivor]) {
          await upsertSessionEntry(entry);
        }

        const listener = new DiscordThreadDeleteListener(cfg, "session-store-integration");
        const deletedThread: GatewayThreadDeleteDispatchData = {
          id: THREAD_ID,
          guild_id: "887766554433221100",
          parent_id: "776655443322110099",
          type: ChannelType.PublicThread,
        };

        await listener.handle(deletedThread);

        expect(getSessionEntry(main)).toBeUndefined();
        expect(getSessionEntry(work)).toBeUndefined();
        expect(getSessionEntry(survivor)).toMatchObject({
          sessionId: "main-survivor-session",
          updatedAt: 3_000,
        });
      });
    });
  });
});
