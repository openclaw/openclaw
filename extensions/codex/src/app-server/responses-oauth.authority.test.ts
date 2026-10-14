import { MessagePort, Worker } from "node:worker_threads";
import {
  findPersistedAuthProfileCredentialAsync,
  saveAuthProfileStore,
  type AuthProfileStore,
  type OAuthCredential,
} from "openclaw/plugin-sdk/agent-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import {
  createCodexResponsesOAuth,
  resolveCodexResponsesOAuthProfileFingerprint,
} from "./responses-oauth.js";

function expectNoDatabaseWork(assertCurrent: () => void) {
  const sql = observeHostDataSql();
  const requests = vi.spyOn(Worker.prototype, "postMessage");
  const messages = vi.spyOn(MessagePort.prototype, "postMessage");
  try {
    assertCurrent();
  } finally {
    const workerRequests = requests.mock.calls.length;
    const portMessages = messages.mock.calls.length;
    sql.restore();
    requests.mockRestore();
    messages.mockRestore();
    expect(sql.queries).toEqual([]);
    expect(workerRequests).toBe(0);
    expect(portMessages).toBe(0);
  }
}

it.each(["shared", "agent"] as const)(
  "keeps prepared %s OAuth guards SQL-free and denies a revoked bearer before native fetch",
  async (scope) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config = { plugins: { enabled: false } };
      await state.writeConfig(config);
      const profileId = "openai:token-sharing:authority";
      const agentDir = scope === "agent" ? state.agentDir("fixture") : undefined;
      const credential: OAuthCredential = {
        type: "oauth",
        provider: "openai",
        authFlow: "chatgpt-token-sharing",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: Date.now() + 3_600_000,
        issuer: "https://auth.openai.com",
        clientId: "synthetic-client",
        idToken: `header.${Buffer.from('{"sub":"synthetic-subject"}').toString("base64url")}.signature`,
      };
      const store: AuthProfileStore = {
        version: 1,
        profiles: { [profileId]: credential },
        runtimePersistedProfileIds: [profileId],
      };
      const save = (value: AuthProfileStore) =>
        saveAuthProfileStore(value, agentDir, {
          filterExternalAuthProfiles: false,
          syncExternalCli: false,
        });
      save(store);
      const auth = await createCodexResponsesOAuth({
        profileId,
        agentDir,
        store,
        config,
        fingerprint: await resolveCodexResponsesOAuthProfileFingerprint({ profileId, store }),
      });
      const prepared = await auth.resolve(false);
      expect(prepared.token).toBe("synthetic-access");
      expect(await findPersistedAuthProfileCredentialAsync({ profileId, agentDir })).toEqual(
        credential,
      );
      expectNoDatabaseWork(() => {
        for (let attempt = 0; attempt < 3; attempt++) {
          prepared.assertCurrent();
        }
      });

      const revoked = { ...credential, authFlow: "chatgpt-identity" };
      const fetchImpl = vi.fn(async () => new Response("must not be sent"));
      const beforeRequest = vi.fn(() => expectNoDatabaseWork(prepared.assertCurrent));
      await expect(
        fetchWithSsrFGuard({
          url: "https://public.example/responses",
          init: { headers: { authorization: `Bearer ${prepared.token}` } },
          capture: false,
          fetchImpl,
          lookupFn: async () => {
            save({ ...store, profiles: { [profileId]: revoked } });
            return [{ address: "93.184.216.34", family: 4 }];
          },
          beforeRequest,
        }),
      ).rejects.toThrow("subscription sharing is unavailable");
      expect(beforeRequest).toHaveBeenCalledOnce();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(await findPersistedAuthProfileCredentialAsync({ profileId, agentDir })).toEqual(
        revoked,
      );
    });
  },
);
