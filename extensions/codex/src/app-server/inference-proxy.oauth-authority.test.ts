import { request } from "node:http";
import type { AuthProfileStore, OAuthCredential } from "openclaw/plugin-sdk/agent-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { createCodexInferenceProxy } from "./inference-proxy.js";
import {
  createCodexResponsesOAuth,
  resolveCodexResponsesOAuthProfileFingerprint,
} from "./responses-oauth.js";

const transport = vi.hoisted(() => ({
  prepare: async () => {},
  lookup: vi.fn(),
  fetch: vi.fn(async () => new Response("synthetic response")),
  beforeRequest: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (args: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({
        ...args,
        // Keep transport preparation deterministic without using ambient proxies or external I/O.
        dispatcherPolicy: { mode: "direct" },
        lookupFn: async () => {
          transport.lookup();
          await transport.prepare();
          return [{ address: "93.184.216.34", family: 4 }];
        },
        beforeRequest: () => {
          transport.beforeRequest();
          args.beforeRequest?.();
        },
        fetchImpl: transport.fetch,
      }),
  };
});

async function post(url: string, body: unknown) {
  if (new URL(url).hostname !== "127.0.0.1") {
    throw new Error("fixture requires its own loopback relay");
  }
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = request(url, { method: "POST", agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.once("error", reject);
      res.once("end", () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.once("error", reject);
    req.end(JSON.stringify(body));
  });
}

it.each(["valid", "identity-only", "revoked", "reassigned"] as const)(
  "enforces persisted %s grant authority through the production Responses relay",
  async (state) => {
    transport.lookup.mockClear();
    transport.fetch.mockClear();
    transport.beforeRequest.mockClear();
    transport.prepare = async () => {};
    await withOpenClawTestState({ scenario: "minimal" }, async (fixture) => {
      const config = { plugins: { enabled: false } };
      await fixture.writeConfig(config);
      const profileId = "openai:token-sharing:relay-authority";
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
      const save = (profiles: AuthProfileStore["profiles"]) =>
        fixture.writeAuthProfiles({ ...store, profiles });
      await save(store.profiles);
      const oauth = await createCodexResponsesOAuth({
        profileId,
        agentDir: fixture.agentDir(),
        store,
        config,
        fingerprint: await resolveCodexResponsesOAuthProfileFingerprint({ profileId, store }),
      });
      const proxy = await createCodexInferenceProxy({
        upstream: new URL("https://api.openai.com/v1"),
        assertCurrent: () => {},
        oauth,
      });
      const registration = await proxy.context.register({
        threadId: "synthetic-root",
        text: "synthetic context",
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
      try {
        if (state === "identity-only") {
          await save({ [profileId]: { ...credential, authFlow: "chatgpt-identity" } });
        }
        // DNS follows real OAuth resolution, so these writes invalidate its retained capability.
        transport.prepare = async () => {
          if (state === "revoked") {
            await save({});
          } else if (state === "reassigned") {
            await save({
              [profileId]: {
                ...credential,
                idToken: `header.${Buffer.from('{"sub":"synthetic-replacement"}').toString("base64url")}.signature`,
              },
            });
          }
        };
        const result = await post(proxy.baseUrl + "/responses", {
          model: "synthetic-model",
          instructions: "synthetic base",
          input: [],
          client_metadata: {
            "x-codex-turn-metadata": JSON.stringify({
              thread_id: "synthetic-root",
              request_kind: "turn",
              [CODEX_INFERENCE_GENERATION_KEY]: registration.generation,
            }),
          },
        });
        const expectedPreparations = state === "identity-only" ? 0 : 1;
        expect(transport.lookup).toHaveBeenCalledTimes(expectedPreparations);
        expect(transport.beforeRequest).toHaveBeenCalledTimes(expectedPreparations);
        expect(transport.fetch).toHaveBeenCalledTimes(state === "valid" ? 1 : 0);
        expect(result.status).toBe(state === "valid" ? 200 : 502);
        expect(result.body).toBe(
          state === "valid"
            ? "synthetic response"
            : "Codex parent-local inference transport failed; retry on a fresh connection.",
        );
        console.info("synthetic sharing relay", {
          state,
          status: result.status,
          transportPreparations: transport.lookup.mock.calls.length,
          finalAuthorityChecks: transport.beforeRequest.mock.calls.length,
          upstreamFetchCalls: transport.fetch.mock.calls.length,
        });
      } finally {
        registration.release();
        proxy.close();
        transport.prepare = async () => {};
      }
    });
  },
);
