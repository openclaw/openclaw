import { createHash } from "node:crypto";
import type { AgentHarnessAttemptParamsV3 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import type { StoredBinding } from "./agentsapi-binding-record.js";
import {
  createAttempt,
  executorFixture,
  mockClient,
  registerHarness,
  reopenState,
} from "./agentsapi-harness.persistence.test-helpers.js";
import { createHostedSession } from "./agentsapi.test-support.js";

const legacy = {
  sessionId: "stable-native-session",
  authFingerprint: "3c26b68488ce497a69d2c9fce9ee19c461fa67a3d959b0dc3bafe5718c56119d",
};
const legacySession = () => ({ ...createHostedSession(), id: legacy.sessionId });

function guardedResponse(finalUrl: string, response: Response) {
  return { finalUrl, response, release: async () => {} };
}

function migrationStore<T = StoredBinding>(
  env: NodeJS.ProcessEnv,
): Required<PluginStateKeyedStore<T>> {
  return createPluginStateKeyedStoreForTests<T>("agentsapi", {
    namespace: "agentsapi-sessions",
    maxEntries: 100_000,
    overflowPolicy: "reject-new",
    env,
  });
}

function pluginConfig(config: Record<string, unknown>): OpenClawConfig {
  return { plugins: { entries: { agentsapi: { config } } } };
}

type MigrationFixture<T> = {
  params: Awaited<ReturnType<typeof createAttempt>>;
  store: ReturnType<typeof migrationStore<T>>;
  client: ReturnType<typeof mockClient>;
  harness: ReturnType<typeof registerHarness>;
  config: { current: OpenClawConfig };
};

function withMigration<T = StoredBinding>(
  run: (fixture: MigrationFixture<T>) => Promise<void>,
  initialConfig: OpenClawConfig = {},
) {
  return withOpenClawTestState({ label: "agentsapi-migration" }, async ({ stateDir, env }) => {
    const config = { current: initialConfig };
    const fixture = {
      params: await createAttempt(stateDir),
      store: migrationStore<T>(env),
      client: mockClient("must-not-create"),
      harness: registerHarness(env, () => config.current),
      config,
    };
    try {
      await run(fixture);
    } finally {
      await fixture.harness.dispose();
    }
  });
}

function expectNoCalls(...mocks: unknown[]) {
  mocks.forEach((mock) => expect(mock).not.toHaveBeenCalled());
}

export function registerMigrationTests(
  fetchMock: ReturnType<typeof vi.fn<typeof fetchWithSsrFGuard>>,
) {
  // v2026.9.9 stores the hash of [model.id, resolvedApiKey], not configFingerprint.
  it("upgrades a v2026.9.9 hosted binding without replacing its remote session", () =>
    withOpenClawTestState({ label: "agentsapi-stable-upgrade" }, async (state) => {
      const params = await createAttempt(state.stateDir);
      const openStore = () => migrationStore<unknown>(state.env);
      await openStore().register(params.sessionId, legacy);
      const { create, message, session } = mockClient("must-not-create");
      session.mockResolvedValue(legacySession());
      const canonical = {
        sessionId: legacy.sessionId,
        configFingerprint: "7279f68deebd4e52eb136c95ccbb8c642a7f141b836a33de22c8aa9a4a93c022",
      };
      for (const resolvedApiKey of [params.resolvedApiKey, "fixture-rotated-key"]) {
        await reopenState();
        const harness = registerHarness(state.env);
        try {
          expect(await harness.runAttempt({ ...params, resolvedApiKey })).toMatchObject({
            terminal: { kind: "ok" },
          });
          expect(await openStore().lookup(params.sessionId)).toEqual(canonical);
        } finally {
          await harness.dispose();
        }
      }
      expect(create).not.toHaveBeenCalled();
      expect(message.mock.calls.map(([id]) => id)).toEqual([legacy.sessionId, legacy.sessionId]);
    }));

  it("retains legacy state rather than guessing after credential or immutable policy changes", () =>
    withMigration(async ({ params, store, client, harness, config }) => {
      await store.register(params.sessionId, legacy);
      const changed = { transport: "streamable-http" as const, url: "https://mcp.example.test" };
      const cases: Array<[string, Partial<AgentHarnessAttemptParamsV3>, OpenClawConfig?]> = [
        ["rotated key", { resolvedApiKey: "fixture-rotated-key" }],
        ["model", { model: { ...params.model, id: "different-model" } }],
        ["environment", {}, pluginConfig({ environment: "self_hosted" })],
        ["network", {}, pluginConfig({ openai_host: { network: { access: "disabled" } } })],
        ["MCP", { config: { mcp: { servers: { changed } } } }],
        ["native search", { toolOverrides: { webSearch: false } }],
        ["Gateway forwarding", {}, pluginConfig({ forwarding: { gatewayTools: false } })],
        ["MCP forwarding", {}, pluginConfig({ forwarding: { mcpServers: false } })],
      ];
      for (const [name, overrides, nextConfig] of cases) {
        config.current = nextConfig ?? {};
        await expect(harness.runAttempt({ ...params, ...overrides })).rejects.toThrow(
          "restore the original configuration and API key",
        );
        expect(await store.lookup(params.sessionId), name).toEqual(legacy);
      }
      expectNoCalls(client.session, client.create, client.update, client.message);
    }));

  it("retains corrupt and partial binding rows before either resume or cleanup", () =>
    withMigration<unknown>(async ({ params, client, harness, store }) => {
      for (const row of [
        { sessionId: legacy.sessionId },
        { authFingerprint: legacy.authFingerprint },
        { ...legacy, configFingerprint: "ambiguous" },
        { ...legacy, authFingerprint: "not-a-digest" },
        { ...legacy, lease: { token: "incomplete" } },
        { ...legacy, unknown: "must-not-strip" },
      ]) {
        await store.register(params.sessionId, row);
        await expect(harness.runAttempt(params)).rejects.toThrow("Invalid Agents API binding row");
        await expect(harness.reset({ ...params.sessionTarget, reason: "reset" })).rejects.toThrow(
          "Invalid Agents API binding row",
        );
        expect(await store.lookup(params.sessionId)).toEqual(row);
      }
      expectNoCalls(client.session, client.create, client.message);
    }));

  it("checks current-key SDK access before upgrading and retains failed admission for retry", () =>
    withMigration(async ({ params, store, client, harness }) => {
      await store.register(params.sessionId, legacy);
      client.session.mockRestore();
      const error = { error: { message: "fixture access refused", type: "invalid_request_error" } };
      for (const status of [401, 403, 404, 500]) {
        fetchMock.mockImplementationOnce(async ({ url, init }) => {
          expect(url).toBe("https://api.openai.com/v1/agents/sessions/" + legacy.sessionId);
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer " + params.resolvedApiKey,
          );
          return guardedResponse(url, Response.json(error, { status }));
        });
        await expect(harness.runAttempt(params)).rejects.toThrow("fixture access refused");
        expect(await store.lookup(params.sessionId)).toEqual(legacy);
      }
      fetchMock.mockImplementationOnce(async () => {
        throw new TypeError("fixture transport unavailable");
      });
      await expect(harness.runAttempt(params)).rejects.toThrow();
      expect(await store.lookup(params.sessionId)).toEqual(legacy);
      expectNoCalls(client.create, client.update, client.message);
      fetchMock.mockImplementationOnce(async ({ url }) =>
        guardedResponse(url, Response.json(legacySession())),
      );
      expect(await harness.runAttempt(params)).toMatchObject({ terminal: { kind: "ok" } });
      expect(await store.lookup(params.sessionId)).toMatchObject({
        sessionId: legacy.sessionId,
        configFingerprint: expect.any(String),
      });
      expect(fetchMock).toHaveBeenCalledTimes(6);
    }));

  it("fences legacy migration when generation, lease, or source changes during access validation", () =>
    withMigration(async ({ params, store, client, harness }) => {
      let active = true;
      params.hostCapabilities.assertActive = () => {
        if (!active) {
          throw new Error("fixture authority revoked");
        }
      };
      try {
        const changes: Array<[string, StoredBinding, string]> = [
          ["authority", legacy, "fixture authority revoked"],
          [
            "lease",
            { ...legacy, lease: { token: "successor", expiresAt: Date.now() + 65_000 } },
            "lease lost",
          ],
          ["source", { ...legacy, authFingerprint: "a".repeat(64) }, "changed during migration"],
        ];
        for (const [change, expected, error] of changes) {
          active = true;
          await store.register(params.sessionId, legacy);
          client.session.mockImplementationOnce(async () => {
            const current = (await store.lookup(params.sessionId))!;
            active = change !== "authority";
            if (active) {
              await store.register(params.sessionId, {
                ...expected,
                lease: expected.lease ?? current.lease,
              });
            }
            return legacySession();
          });
          await expect(harness.runAttempt(params)).rejects.toThrow(error);
          expect(await store.lookup(params.sessionId)).toEqual(expected);
        }
        expectNoCalls(client.create, client.update, client.message);
      } finally {
        active = true;
      }
    }));

  it("resumes a shipped self-hosted binding with an expired lease without adopting an executor owner", () =>
    withMigration(
      async ({ params, store, client, harness }) => {
        // Exact v2026.9.9 producer identity, with its workspace-dependent environment.
        const environment = { type: "self_hosted", workspace_directory: params.workspaceDir };
        const row = {
          sessionId: legacy.sessionId,
          authFingerprint: createHash("sha256")
            .update(JSON.stringify([params.model.id, params.resolvedApiKey, environment]))
            .digest("hex"),
        };
        await store.register(params.sessionId, {
          ...row,
          lease: { token: "expired-owner", expiresAt: Date.now() - 1 },
        });
        client.session.mockResolvedValue(legacySession());
        expect(await harness.runAttempt(params)).toMatchObject({ terminal: { kind: "ok" } });
        const saved = await store.lookup(params.sessionId);
        expect(saved).toEqual({ sessionId: row.sessionId, configFingerprint: expect.any(String) });
        expect(saved?.configFingerprint).not.toBe(row.authFingerprint);
        expect(client.create).not.toHaveBeenCalled();
      },
      pluginConfig({ environment: "self_hosted" }),
    ));

  it.each(["reset", "delete", "context rollback"] as const)(
    "settles unmigratable legacy work before %s with current agent authentication",
    (operation) =>
      withOpenClawTestState({ label: "agentsapi-upgrade-cleanup" }, async (state) => {
        const { params, ...fixture } = await executorFixture(state);
        const store = migrationStore(state.env);
        await store.register(params.sessionId, legacy);
        await reopenState();
        fixture.session.mockResolvedValue({
          ...fixture.nativeSession,
          id: legacy.sessionId,
          status: "in_progress",
        });
        const harness = fixture.createHarness();
        const target = { ...params.sessionTarget, assertCurrent: () => {} };
        const successor = {
          sessionId: "successor-local-session",
          previousSessionId: params.sessionId,
        };
        if (operation === "context rollback") {
          await patchSessionEntry({ ...params.sessionTarget, update: () => successor });
        }
        const cleanup = () =>
          operation === "reset"
            ? harness.reset({ ...target, reason: "reset" })
            : operation === "delete"
              ? harness.withSessionDeletion(target, async (settle) => settle())
              : harness.withSessionContextReset({ ...target, ...successor }, (settle) =>
                  settle("rollback"),
                );
        try {
          fixture.cancel.mockRejectedValueOnce(new Error("fixture settlement unavailable"));
          await expect(cleanup()).rejects.toThrow("fixture settlement unavailable");
          expect(await store.lookup(params.sessionId)).toEqual(legacy);
          await cleanup();
          expect((await store.lookup(params.sessionId)) ?? {}).toEqual(
            operation === "context rollback" ? legacy : {},
          );
          const cancelledIds = fixture.cancel.mock.calls.map(([id]) => id);
          expect(cancelledIds).toEqual([legacy.sessionId, legacy.sessionId]);
          expectNoCalls(fixture.controller.retire, fixture.create);
        } finally {
          await harness.dispose();
        }
      }),
  );
}
