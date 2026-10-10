import { createHash } from "node:crypto";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
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

function migrationStore(env: NodeJS.ProcessEnv) {
  return createPluginStateKeyedStoreForTests<StoredBinding>("agentsapi", {
    namespace: "agentsapi-sessions",
    maxEntries: 100_000,
    overflowPolicy: "reject-new",
    env,
  });
}

/** Reuses the registered harness, SQLite fixture, and deterministic native transport. */
export function registerMigrationTests(
  fetchMock: ReturnType<
    typeof vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>
  >,
) {
  // v2026.9.9 agentsapi-attempt.ts hashes [model.id, resolvedApiKey] for hosted sessions.
  // Its agentsapi-bindings.ts stores this pair, not configFingerprint.
  it("upgrades a v2026.9.9 hosted binding without replacing its remote session", async () => {
    await withOpenClawTestState({ label: "agentsapi-stable-upgrade" }, async (state) => {
      const params = await createAttempt(state.stateDir);
      const openStore = () =>
        createPluginStateKeyedStoreForTests<unknown>("agentsapi", {
          namespace: "agentsapi-sessions",
          maxEntries: 100_000,
          overflowPolicy: "reject-new",
          env: state.env,
        });
      await openStore().register(params.sessionId, legacy);
      await reopenState();
      const { create, message, session } = mockClient("must-not-create");
      session.mockResolvedValue({ ...createHostedSession(), id: legacy.sessionId });
      let harness = registerHarness(state.env);
      try {
        expect(await harness.runAttempt(params)).toMatchObject({ terminal: { kind: "ok" } });
        const canonical = {
          sessionId: legacy.sessionId,
          configFingerprint: "7279f68deebd4e52eb136c95ccbb8c642a7f141b836a33de22c8aa9a4a93c022",
        };
        expect(await openStore().lookup(params.sessionId)).toEqual(canonical);
        await harness.dispose();
        await reopenState();
        harness = registerHarness(state.env);
        expect(
          await harness.runAttempt({ ...params, resolvedApiKey: "fixture-rotated-key" }),
        ).toMatchObject({ terminal: { kind: "ok" } });
        expect(await openStore().lookup(params.sessionId)).toEqual(canonical);
        expect(create).not.toHaveBeenCalled();
        expect(message.mock.calls.map(([id]) => id)).toEqual([legacy.sessionId, legacy.sessionId]);
      } finally {
        await harness.dispose();
      }
    });
  });

  it("retains legacy state rather than guessing after credential or immutable policy changes", async () => {
    await withOpenClawTestState({ label: "agentsapi-upgrade-policy" }, async (state) => {
      const params = await createAttempt(state.stateDir);
      const store = migrationStore(state.env);
      await store.register(params.sessionId, legacy);
      const client = mockClient("must-not-create");
      let config: OpenClawConfig = {};
      const harness = registerHarness(state.env, () => config);
      const cases: Array<{
        name: string;
        config?: OpenClawConfig;
        params?: Partial<AgentHarnessAttemptParamsV2>;
      }> = [
        { name: "rotated key", params: { resolvedApiKey: "fixture-rotated-key" } },
        { name: "model", params: { model: { ...params.model, id: "different-model" } } },
        {
          name: "environment",
          config: {
            plugins: { entries: { agentsapi: { config: { environment: "self_hosted" } } } },
          },
        },
        {
          name: "network",
          config: {
            plugins: {
              entries: {
                agentsapi: { config: { openai_host: { network: { access: "disabled" } } } },
              },
            },
          },
        },
        {
          name: "MCP",
          params: {
            config: {
              mcp: {
                servers: {
                  changed: { transport: "streamable-http", url: "https://mcp.example.test" },
                },
              },
            },
          },
        },
        { name: "native search", params: { toolOverrides: { webSearch: false } } },
      ];
      try {
        for (const entry of cases) {
          config = entry.config ?? {};
          await expect(harness.runAttempt({ ...params, ...entry.params })).rejects.toThrow(
            "restore the original configuration and API key",
          );
          expect(await store.lookup(params.sessionId), entry.name).toEqual(legacy);
        }
        expect(client.session).not.toHaveBeenCalled();
        expect(client.create).not.toHaveBeenCalled();
        expect(client.update).not.toHaveBeenCalled();
        expect(client.message).not.toHaveBeenCalled();
      } finally {
        await harness.dispose();
      }
    });
  });

  it("retains corrupt and partial binding rows before either resume or cleanup", async () => {
    await withOpenClawTestState({ label: "agentsapi-upgrade-corrupt" }, async (state) => {
      const params = await createAttempt(state.stateDir);
      const store = createPluginStateKeyedStoreForTests<unknown>("agentsapi", {
        namespace: "agentsapi-sessions",
        maxEntries: 100_000,
        overflowPolicy: "reject-new",
        env: state.env,
      });
      const client = mockClient("must-not-create");
      const harness = registerHarness(state.env);
      const rows = [
        { sessionId: legacy.sessionId },
        { authFingerprint: legacy.authFingerprint },
        { ...legacy, configFingerprint: "ambiguous" },
        { ...legacy, authFingerprint: "not-a-digest" },
        { ...legacy, lease: { token: "incomplete" } },
        { ...legacy, unknown: "must-not-strip" },
      ];
      try {
        for (const row of rows) {
          await store.register(params.sessionId, row);
          await expect(harness.runAttempt(params)).rejects.toThrow(
            "Invalid Agents API binding row",
          );
          await expect(harness.reset({ ...params.sessionTarget, reason: "reset" })).rejects.toThrow(
            "Invalid Agents API binding row",
          );
          expect(await store.lookup(params.sessionId)).toEqual(row);
        }
        expect(client.session).not.toHaveBeenCalled();
        expect(client.create).not.toHaveBeenCalled();
        expect(client.message).not.toHaveBeenCalled();
      } finally {
        await harness.dispose();
      }
    });
  });

  it("checks current-key SDK access before upgrading and retains failed admission for retry", async () => {
    await withOpenClawTestState({ label: "agentsapi-upgrade-access" }, async (state) => {
      const params = await createAttempt(state.stateDir);
      const store = migrationStore(state.env);
      await store.register(params.sessionId, legacy);
      const client = mockClient("must-not-create");
      client.session.mockRestore();
      const harness = registerHarness(state.env);
      try {
        for (const status of [401, 403, 404, 500]) {
          fetchMock.mockImplementationOnce(async ({ url, init }) => {
            expect(url).toBe("https://api.openai.com/v1/agents/sessions/" + legacy.sessionId);
            expect(new Headers(init?.headers).get("authorization")).toBe(
              "Bearer " + params.resolvedApiKey,
            );
            return {
              finalUrl: url,
              response: Response.json(
                { error: { message: "fixture access refused", type: "invalid_request_error" } },
                { status },
              ),
              release: async () => {},
            };
          });
          await expect(harness.runAttempt(params)).rejects.toThrow("fixture access refused");
          expect(await store.lookup(params.sessionId)).toEqual(legacy);
        }
        fetchMock.mockImplementationOnce(async () => {
          throw new TypeError("fixture transport unavailable");
        });
        await expect(harness.runAttempt(params)).rejects.toThrow();
        expect(await store.lookup(params.sessionId)).toEqual(legacy);
        expect(client.create).not.toHaveBeenCalled();
        expect(client.update).not.toHaveBeenCalled();
        expect(client.message).not.toHaveBeenCalled();
        fetchMock.mockImplementationOnce(async ({ url }) => ({
          finalUrl: url,
          response: Response.json({ ...createHostedSession(), id: legacy.sessionId }),
          release: async () => {},
        }));
        expect(await harness.runAttempt(params)).toMatchObject({ terminal: { kind: "ok" } });
        expect(await store.lookup(params.sessionId)).toMatchObject({
          sessionId: legacy.sessionId,
          configFingerprint: expect.any(String),
        });
        expect(fetchMock).toHaveBeenCalledTimes(6);
      } finally {
        await harness.dispose();
      }
    });
  });

  it("fences legacy migration when generation, lease, or source changes during access validation", async () => {
    await withOpenClawTestState({ label: "agentsapi-upgrade-authority" }, async (state) => {
      const params = await createAttempt(state.stateDir);
      const store = migrationStore(state.env);
      const client = mockClient("must-not-create");
      let active = true;
      params.hostCapabilities.assertActive = () => {
        if (!active) {
          throw new Error("fixture authority revoked");
        }
      };
      const harness = registerHarness(state.env);
      try {
        for (const change of ["authority", "lease", "source"] as const) {
          active = true;
          await store.register(params.sessionId, legacy);
          let expected: StoredBinding = legacy;
          client.session.mockImplementationOnce(async () => {
            const current = (await store.lookup(params.sessionId))!;
            if (change === "authority") {
              active = false;
            } else {
              expected =
                change === "lease"
                  ? { ...legacy, lease: { token: "successor", expiresAt: Date.now() + 65_000 } }
                  : { ...legacy, authFingerprint: "a".repeat(64) };
              await store.register(params.sessionId, {
                ...expected,
                lease: expected.lease ?? current.lease,
              });
            }
            return { ...createHostedSession(), id: legacy.sessionId };
          });
          await expect(harness.runAttempt(params)).rejects.toThrow(
            change === "authority"
              ? "fixture authority revoked"
              : change === "lease"
                ? "lease lost"
                : "changed during migration",
          );
          expect(await store.lookup(params.sessionId)).toEqual(expected);
        }
        expect(client.create).not.toHaveBeenCalled();
        expect(client.update).not.toHaveBeenCalled();
        expect(client.message).not.toHaveBeenCalled();
      } finally {
        active = true;
        await harness.dispose();
      }
    });
  });

  it("resumes a shipped self-hosted binding with an expired lease without adopting an executor owner", async () => {
    await withOpenClawTestState({ label: "agentsapi-upgrade-self-hosted" }, async (state) => {
      const params = await createAttempt(state.stateDir);
      // Exact v2026.9.9 producer identity, with its workspace-dependent environment.
      const row = {
        sessionId: legacy.sessionId,
        authFingerprint: createHash("sha256")
          .update(
            JSON.stringify([
              params.model.id,
              params.resolvedApiKey,
              { type: "self_hosted", workspace_directory: params.workspaceDir },
            ]),
          )
          .digest("hex"),
      };
      const store = migrationStore(state.env);
      await store.register(params.sessionId, {
        ...row,
        lease: { token: "expired-owner", expiresAt: Date.now() - 1 },
      });
      const client = mockClient("must-not-create");
      client.session.mockResolvedValue({ ...createHostedSession(), id: row.sessionId });
      const harness = registerHarness(state.env, () => ({
        plugins: { entries: { agentsapi: { config: { environment: "self_hosted" } } } },
      }));
      try {
        expect(await harness.runAttempt(params)).toMatchObject({ terminal: { kind: "ok" } });
        const saved = await store.lookup(params.sessionId);
        expect(saved).toEqual({ sessionId: row.sessionId, configFingerprint: expect.any(String) });
        expect(saved?.configFingerprint).not.toBe(row.authFingerprint);
        expect(client.create).not.toHaveBeenCalled();
      } finally {
        await harness.dispose();
      }
    });
  });

  it.each(["reset", "delete", "context rollback"] as const)(
    "settles unmigratable legacy work before %s with current agent authentication",
    async (operation) => {
      await withOpenClawTestState({ label: "agentsapi-upgrade-cleanup" }, async (state) => {
        const fixture = await executorFixture(state);
        const store = migrationStore(state.env);
        await store.register(fixture.params.sessionId, legacy);
        await reopenState();
        fixture.session.mockResolvedValue({
          ...fixture.nativeSession,
          id: legacy.sessionId,
          status: "in_progress",
        });
        const harness = fixture.createHarness();
        const cleanup = () =>
          operation === "reset"
            ? harness.reset({ ...fixture.params.sessionTarget, reason: "reset" })
            : operation === "delete"
              ? harness.withSessionDeletion(
                  { ...fixture.params.sessionTarget, assertCurrent: () => {} },
                  async (mutation) => mutation.commit(),
                )
              : harness.withSessionContextReset(
                  {
                    ...fixture.params.sessionTarget,
                    sessionId: "successor-local-session",
                    previousSessionId: fixture.params.sessionId,
                    assertCurrent: () => {},
                  },
                  async (mutation) => {
                    mutation.commit();
                    mutation.rollback();
                  },
                );
        try {
          fixture.cancel.mockRejectedValueOnce(new Error("fixture settlement unavailable"));
          await expect(cleanup()).rejects.toThrow("fixture settlement unavailable");
          expect(await store.lookup(fixture.params.sessionId)).toEqual(legacy);
          await cleanup();
          expect((await store.lookup(fixture.params.sessionId)) ?? {}).toEqual(
            operation === "context rollback" ? legacy : {},
          );
          expect(fixture.cancel.mock.calls.map(([id]) => id)).toEqual([
            legacy.sessionId,
            legacy.sessionId,
          ]);
          expect(fixture.controller.retire).not.toHaveBeenCalled();
          expect(fixture.create).not.toHaveBeenCalled();
        } finally {
          await harness.dispose();
        }
      });
    },
  );
}
