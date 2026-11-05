import "openclaw/plugin-sdk/compiled-subprocess-testing";
import "./service-http-mock.test-support.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getEnvironmentData } from "node:worker_threads";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import * as state from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  deleteSessionEntry,
  getSessionEntry,
  getSessionEntryAsync,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import pg from "pg";
import { afterAll, expect, it } from "vitest";
import { ClickClackHttpError } from "../http-client.js";
import type { ClickClackChannel, CoreConfig } from "../types.js";
import { getClickClackDiscussionBindingStore } from "./binding-store.js";
import { registerDiscussionTestTransport } from "./service-http-transport.test-support.js";
import { ClickClackDiscussionService } from "./service.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

it("opens discussions through real agent storage, follows HTTP resets, and refuses retired authority", async () => {
  const stateDir = tempDirs.make("clickclack-agent-storage-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.sqlite");
  const channels: ClickClackChannel[] = [];
  let lists = 0;
  let beforeList: (() => Promise<void>) | undefined;
  let duringCreate: (() => Promise<void>) | undefined;
  const apiBaseUrl = registerDiscussionTestTransport(
    {
      workspaces: async () => [
        {
          id: "workspace",
          name: "Proof",
          slug: "proof",
          route_id: "proof",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      channels: async () => {
        lists += 1;
        await beforeList?.();
        return channels;
      },
      createChannel: async (_workspaceId, input) => {
        const channel = {
          id: "channel-" + channels.length,
          workspace_id: "workspace",
          route_id: "route-" + channels.length,
          archived: false,
          created_at: "2026-01-01T00:00:00Z",
          ...input,
        };
        channels.push(channel);
        await duringCreate?.();
        return channel;
      },
      updateChannel: async (id, patch) => {
        const channel = channels.find((value) => value.id === id);
        if (!channel) {
          throw new Error("Unknown fixture channel");
        }
        Object.assign(channel, patch);
        return channel;
      },
      messagePage: async () => ({ messages: [], oldest_seq: 0, has_older: false }),
    },
    ClickClackHttpError,
  );
  const config = {
    session: { store: storePath },
    channels: {
      clickclack: {
        baseUrl: "https://clickclack.example",
        apiBaseUrl,
        token: "synthetic",
        workspace: "workspace",
        discussions: { enabled: true, workspace: "workspace" },
      },
    },
  } satisfies CoreConfig;
  const runtime = createPluginRuntimeMock({
    config: { current: () => config },
    state: {
      resolveStateDir: () => stateDir,
      openKeyedStoreV2: (options, authority) =>
        state.createPluginStateKeyedStoreV2ForTests(
          "clickclack",
          { ...options, env },
          authority ?? { assertCurrent() {} },
        ),
    },
    agent: {
      session: {
        resolveStorePath,
        // Keep the released reader real so this regression fails on the old opening path on PostgreSQL.
        getSessionEntry: (params) => getSessionEntry({ storePath, ...params, env }),
        getSessionEntryAsync: (params) => getSessionEntryAsync({ storePath, ...params, env }),
      },
    },
  });
  const service = new ClickClackDiscussionService(runtime);
  const database = {
    effectiveEngines: state.resolveDatabaseFamilyEngines({
      database: {
        engine: "sqlite",
        families: { agent: { engine: connection ? "postgres" : "sqlite" } },
      },
    }),
    ...(connection ? { postgres: { connection, schemaPrefix: "clickclack_agent_test" } } : {}),
  };
  const scope = (name: string) => ({
    agentId: "main",
    storePath,
    env,
    sessionKey: "agent:main:" + name,
  });
  const write = (name: string, sessionId = name, archivedAt?: number) =>
    upsertSessionEntry({
      ...scope(name),
      entry: {
        sessionId,
        updatedAt: Date.now(),
        label: name,
        ...(archivedAt === undefined ? {} : { archivedAt }),
      },
    });
  try {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      state.withDatabaseEngineSelection(database, async () => {
        for (const reset of [false, true]) {
          const name = reset ? "reset-during-http" : "ordinary-open";
          await write(name);
          expect(await getSessionEntryAsync(scope(name))).toMatchObject({ sessionId: name });
          duringCreate = reset ? () => write(name, "replacement") : undefined;
          await expect(service.open(scope(name).sessionKey)).resolves.toMatchObject({
            state: "open",
          });
          expect(
            await getClickClackDiscussionBindingStore(runtime).getAsync(scope(name).sessionKey),
          ).toMatchObject({ sessionId: reset ? "replacement" : name });
        }
        duringCreate = async () => {
          throw new Error("Ambiguous fixture transport failure");
        };
        await write("recover-attempted");
        const recoveryLists = lists;
        await expect(service.open(scope("recover-attempted").sessionKey)).resolves.toMatchObject({
          state: "open",
        });
        expect(lists).toBe(recoveryLists + 2);
        duringCreate = undefined;
        for (const change of ["archive", "remove", "credential", "destination"] as const) {
          await write(change);
          const creates = channels.length;
          const initialLists = lists;
          beforeList = async () => {
            beforeList = undefined;
            if (change === "archive") {
              await write(change, change, 1);
            } else if (change === "remove") {
              await deleteSessionEntry(scope(change));
            } else if (change === "credential") {
              config.channels.clickclack.token = "replacement-token";
            } else {
              config.channels.clickclack.apiBaseUrl = "https://replacement.fixture.invalid";
            }
          };
          await expect(service.open(scope(change).sessionKey)).rejects.toThrow(
            /authority changed|selected session changed/,
          );
          expect(channels).toHaveLength(creates);
          expect(lists).toBe(initialLists + 1);
          config.channels.clickclack.token = "synthetic";
          config.channels.clickclack.apiBaseUrl = apiBaseUrl;
        }
        for (const change of ["archive", "credential", "destination"] as const) {
          const name = "retire-during-http-" + change;
          await write(name);
          const initialLists = lists;
          duringCreate = async () => {
            if (change === "archive") {
              await write(name, name, 1);
            } else if (change === "credential") {
              config.channels.clickclack.token = "retired";
            } else {
              config.channels.clickclack.apiBaseUrl = "https://retired.fixture.invalid";
            }
            throw new Error("Ambiguous fixture transport failure");
          };
          await expect(service.open(scope(name).sessionKey)).rejects.toThrow(
            "Ambiguous fixture transport failure",
          );
          expect(lists).toBe(initialLists + 1);
          expect(
            await getClickClackDiscussionBindingStore(runtime).getAsync(scope(name).sessionKey),
          ).toBeUndefined();
          config.channels.clickclack.token = "synthetic";
          config.channels.clickclack.apiBaseUrl = apiBaseUrl;
        }
      }),
    );
  } finally {
    await service.cleanup();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    if (connection && existsSync(storePath)) {
      using anchor = new DatabaseSync(storePath, { readOnly: true });
      const row = anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get();
      if (typeof row?.schema === "string") {
        const client = new pg.Client({ connectionString: connection });
        await client.connect();
        try {
          await client.query('DROP SCHEMA "' + row.schema.replaceAll('"', '""') + '" CASCADE');
        } finally {
          await client.end();
        }
      }
    }
  }
});
