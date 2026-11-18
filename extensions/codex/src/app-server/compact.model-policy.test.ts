import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { maybeCompactCodexAppServerSession } from "./compact.js";
import { CodexInferenceAuthorizationError } from "./inference-dispatch.js";
import {
  assertCodexInferenceRouteConfig,
  bindCodexInferenceThread,
  ownCodexInferenceClient,
  prepareCodexInferenceThreadConfig,
} from "./inference-routing.js";
import { buildCodexRuntimeModelParams } from "./model-runtime.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import {
  createClientHarness,
  createCodexTestModel,
  stubCodexInferenceTransportEnv,
} from "./test-support.js";

const transport = vi.hoisted(() => ({ fetch: vi.fn<typeof fetchWithSsrFGuard>() }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return { ...actual, fetchWithSsrFGuard: transport.fetch };
});

beforeEach(() => {
  transport.fetch.mockReset();
  setRuntimeConfigSnapshot({});
  stubCodexInferenceTransportEnv();
  // The global fetch dispatcher may already own the host proxy. Keep only this
  // fixture's loopback transport direct while its upstream remains guarded.
  vi.stubEnv("NO_PROXY", "127.0.0.1,localhost,::1");
  vi.stubEnv("no_proxy", "127.0.0.1,localhost,::1");
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

it.each([
  ["cross-provider same-name model", false, false],
  ["same-provider catalog alias", true, false],
  ["revoked compaction source", true, true],
] as const)(
  "native compaction model policy enforces %s",
  async (_scenario, allowed, revokeSource) => {
    const selectedModel = allowed ? "catalog-model" : "shared-model";
    const nativeProvider = allowed ? "allowed-provider" : "other-provider";
    const nativeModel = allowed ? "wire-model" : "shared-model";
    await withStateDirEnv("openclaw-compact-model-policy-", async ({ tempRoot }) => {
      const provider = "allowed-provider";
      const threadId = "compaction-policy-thread";
      const turnId = "compaction-policy-turn";
      const turnEvent = (method: string, status: string, complete = false) => ({
        method,
        params: { threadId, turn: { id: turnId, status, ...(complete ? { items: [] } : {}) } },
      });
      const itemEvent = (method: string) => ({
        method,
        params: { threadId, turnId, item: { id: "item", type: "contextCompaction" } },
      });
      const runId = randomUUID();
      const identity = {
        kind: "session" as const,
        agentId: "main",
        sessionId: "compaction-policy-session",
        sessionKey: "agent:main:compaction-policy",
      };
      const controller = new AbortController();
      const attempt = {
        ...identity,
        runId,
        workspaceDir: tempRoot,
        provider,
        abortSignal: controller.signal,
      };
      let sourceActive = true;
      const host = await createAgentHarnessHostCapabilitiesForTest({
        pluginId: "codex",
        nativeModelPolicySupport: "exact",
        attempt: {
          ...attempt,
          agentDir: path.join(tempRoot, "agent"),
          modelId: selectedModel,
        },
        operatorSource: {
          profileId: "compaction-policy-operator",
          scopes: ["operator.write"],
          assertCurrent: () => {
            if (!sourceActive) {
              throw new Error("Original compaction operator source revoked");
            }
          },
          modelPolicy: {
            models: [{ provider, model: selectedModel }],
            allows: (model) => model.provider === provider && model.model === selectedModel,
          },
        },
      });
      const started = createDeferred<void>();
      const harness = createClientHarness({
        onWrite(line, send) {
          const { id, method } = JSON.parse(line) as { id: number; method: string };
          if (method === "thread/compact/start") {
            send(turnEvent("turn/started", "inProgress"));
            send(itemEvent("item/started"));
            send({ id, result: {} });
            started.resolve();
            return;
          } else if (method === "account/read") {
            send({ id, result: { account: { type: "apiKey" } } });
            return;
          } else if (method !== "turn/interrupt" && method !== "thread/unsubscribe") {
            send({
              id,
              error: { code: -32_601, message: `Unexpected policy fixture RPC: ${method}` },
            });
            return;
          }
          send({ id, result: {} });
        },
      });
      let pending: ReturnType<typeof maybeCompactCodexAppServerSession> | undefined;
      let finalWrites = 0;
      let finalBarrierReached = false;
      let finalAuthorityFailure: unknown;
      transport.fetch.mockImplementation(async (args) => {
        expect(args.url).toBe("https://compaction-policy.example/v1/responses");
        expect(await new Response(args.init?.body).json()).toMatchObject({ model: nativeModel });
        assert(args.beforeRequest);
        args.beforeRequest();
        finalBarrierReached = true;
        if (revokeSource) {
          // Revoke the original issuer only after real admission reached the final transport.
          sourceActive = false;
        }
        try {
          args.beforeRequest();
        } catch (error) {
          finalAuthorityFailure = error;
          throw error;
        }
        finalWrites += 1;
        return {
          response: new Response("synthetic compaction provider response"),
          finalUrl: args.url,
          release: async () => {},
        };
      });
      try {
        ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempRoot });
        ownCodexInferenceClient(harness.client);
        const inference = await prepareCodexInferenceThreadConfig({
          client: harness.client,
          clientId: harness.client.getInstanceId(),
          binding: undefined,
          cwd: tempRoot,
          modelProvider: nativeProvider,
          operatorBacked: true,
          assertCurrent: host.capabilities.assertActive,
          effectiveConfig: {
            config: {
              model_provider: nativeProvider,
              model_providers: {
                [nativeProvider]: {
                  name: "Compaction policy fixture",
                  base_url: "https://compaction-policy.example/v1",
                  wire_api: "responses",
                },
              },
            },
            origins: {},
          },
        });
        assert(inference, "Expected a real owned inference qualification");
        assertCodexInferenceRouteConfig(
          harness.client,
          inference.route,
          inference.config,
          nativeProvider,
          inference.providers,
        );
        bindCodexInferenceThread(harness.client, threadId, inference.route, inference.providers);
        assert(
          await retainCodexAppServerLiveThread(harness.client, threadId),
          "Expected a retained compaction subscription",
        );
        const bindingStore = createCodexTestBindingStore();
        await bindingStore.mutate(identity, {
          kind: "set",
          binding: { threadId, cwd: tempRoot, model: nativeModel, modelProvider: nativeProvider },
        });
        const retainSourceAuthority = host.capabilities.retainSourceAuthority;
        assert(retainSourceAuthority, "Expected the production operator source capability");
        pending = maybeCompactCodexAppServerSession(
          {
            ...attempt,
            sessionFile: path.join(tempRoot, "session.jsonl"),
            model: selectedModel,
            runtimeModel: {
              ...createCodexTestModel(provider),
              id: selectedModel,
              params: buildCodexRuntimeModelParams(selectedModel, nativeModel),
            },
            trigger: "manual",
            hostCapabilities: {
              kind: host.capabilities.kind,
              version: host.capabilities.version,
              assertActive: host.capabilities.assertActive,
              retainSourceAuthority,
            },
          },
          { bindingStore, clientFactory: async () => harness.client },
        );
        await Promise.race([
          started.promise,
          pending.then((result) => {
            throw new Error(`Native compaction did not start: ${JSON.stringify(result)}`);
          }),
        ]);
        const response = await fetch(inference.route.baseUrl + "/responses", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            connection: "close",
            "x-codex-turn-metadata": JSON.stringify({
              thread_id: threadId,
              turn_id: turnId,
              request_kind: "compaction",
            }),
          },
          body: JSON.stringify({ model: nativeModel }),
        });
        const forwarded = allowed && !revokeSource;
        expect(response.status, "native compaction model admission").toBe(forwarded ? 200 : 403);
        if (forwarded) {
          expect(await response.text()).toBe("synthetic compaction provider response");
        } else {
          expect(await response.json()).toMatchObject({
            error: {
              code: "model_permission_denied",
              message: expect.stringContaining(
                revokeSource ? "cannot verify the owner" : "operator role cannot use this model",
              ),
            },
          });
        }
        expect(finalWrites).toBe(forwarded ? 1 : 0);
        expect(transport.fetch).toHaveBeenCalledTimes(allowed ? 1 : 0);
        expect(finalBarrierReached).toBe(allowed);
        if (revokeSource) {
          expect(finalAuthorityFailure).toBeInstanceOf(CodexInferenceAuthorizationError);
        }
        harness.send(itemEvent("item/completed"));
        harness.send(turnEvent("turn/completed", forwarded ? "completed" : "interrupted", true));
        await expect(pending).resolves.toMatchObject({ ok: forwarded, compacted: forwarded });
      } finally {
        harness.send(turnEvent("turn/started", "inProgress"));
        harness.send(turnEvent("turn/completed", "interrupted", true));
        controller.abort();
        await pending?.catch(() => undefined);
        await harness.client.closeAndWait();
        host.close();
      }
    });
  },
);
