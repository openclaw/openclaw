import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  observeHostDataSql,
  openIncognitoTestActor,
  useSessionStoreTempDirs,
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createModelsProviderData, createResolvedAgentRoute } from "./model-picker.test-utils.js";
import {
  prepareDiscordModelPickerSession,
  resolveDiscordModelPickerCurrentModel,
  resolveDiscordModelPickerCurrentRuntime,
} from "./native-command-model-picker-ui.js";

const dirs = useSessionStoreTempDirs(afterAll, "discord-bound-picker-");
const authority = { assertCurrent() {} };
afterEach(() => vi.unstubAllEnvs());

it("rejects inherited model choices after the parent session changes", async () => {
  const env = { OPENCLAW_STATE_DIR: dirs.make() };
  const storePath = path.join(env.OPENCLAW_STATE_DIR, "agents/main/sessions/sessions.json");
  const parentKey = "agent:main:discord:channel:parent";
  const sessionKey = `${parentKey}:thread:child`;
  const cfg: OpenClawConfig = { session: { store: storePath } };
  for (const key of [parentKey, sessionKey]) {
    await upsertSessionEntry({
      agentId: "main",
      env,
      storePath,
      sessionKey: key,
      entry: {
        sessionId: key,
        updatedAt: 1,
        ...(key === parentKey ? { providerOverride: "openai", modelOverride: "selected" } : {}),
      },
    });
  }
  const prepared = await prepareDiscordModelPickerSession({
    cfg,
    route: createResolvedAgentRoute({ sessionKey }),
  });
  await expect(prepared.resolveOverride("openai")).resolves.toMatchObject({
    model: "selected",
    source: "parent",
  });
  await patchSessionEntry({
    agentId: "main",
    env,
    storePath,
    sessionKey: parentKey,
    update: () => ({ modelOverride: "replacement" }),
  });
  expect(() => prepared.assertCurrent()).toThrow();
});

it("reads bound model choices without host SQL and refuses a retired actor", async () => {
  const env = { OPENCLAW_STATE_DIR: dirs.make() };
  const actor = await openIncognitoTestActor(env, authority);
  const sessionKey = "agent:main:dashboard:incognito-picker";
  const route = createResolvedAgentRoute({ sessionKey });
  const cfg: OpenClawConfig = { session: { store: actor.path } };
  const data = createModelsProviderData({ openai: ["configured", "selected"] });
  try {
    await actor.sessions.create(authority, {
      sessionKey,
      entry: {
        sessionId: "selected",
        updatedAt: 1,
        incognito: true,
        providerOverride: "openai",
        modelOverride: "selected",
        agentRuntimeOverride: "openclaw",
      },
    });
    const sql = observeHostDataSql();
    try {
      const prepared = await withIncognitoSessionActor(actor, async () => {
        await expect(resolveDiscordModelPickerCurrentModel({ cfg, route, data })).resolves.toBe(
          "openai/selected",
        );
        await expect(resolveDiscordModelPickerCurrentRuntime({ cfg, route })).resolves.toBe(
          "openclaw",
        );
        return prepareDiscordModelPickerSession({ cfg, route });
      });
      await actor.close();
      expect(() => prepared.assertCurrent()).toThrow(/Incognito session ended/);
      await withIncognitoSessionBinding({ actor }, async () => {
        await expect(
          resolveDiscordModelPickerCurrentModel({ cfg, route, data }),
        ).rejects.toMatchObject({
          code: "INCOGNITO_SESSION_ENDED",
        });
      });
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  } finally {
    await actor.close();
  }
});

it("preserves host-owned unbound incognito and actor-selected absence", async () => {
  const env = { OPENCLAW_STATE_DIR: dirs.make() };
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  const sessionKey = "agent:main:dashboard:incognito-native";
  const storePath = path.join(env.OPENCLAW_STATE_DIR, "agents/main/sessions/sessions.json");
  const cfg: OpenClawConfig = { session: { store: storePath } };
  const route = createResolvedAgentRoute({ sessionKey });
  const data = createModelsProviderData({ openai: ["configured", "native"] });
  await upsertSessionEntry({
    agentId: "main",
    env,
    storePath,
    sessionKey,
    entry: {
      sessionId: "native",
      updatedAt: 1,
      incognito: true,
      providerOverride: "openai",
      modelOverride: "native",
    },
  });
  await expect(resolveDiscordModelPickerCurrentModel({ cfg, route, data })).resolves.toBe(
    "openai/native",
  );
  await withIncognitoSessionBinding(
    { kind: "absent", agentId: "main", env, authority },
    async () => {
      await expect(resolveDiscordModelPickerCurrentModel({ cfg, route, data })).resolves.toBe(
        "openai/configured",
      );
    },
  );
  await expect(resolveDiscordModelPickerCurrentModel({ cfg, route, data })).resolves.toBe(
    "openai/native",
  );
});
