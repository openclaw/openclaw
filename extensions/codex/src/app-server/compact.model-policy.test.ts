import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { createClientHarness, createCodexTestModel } from "./test-support.js";

const transport = vi.hoisted(() => ({ fetch: vi.fn<typeof fetchWithSsrFGuard>() }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return { ...actual, fetchWithSsrFGuard: transport.fetch };
});

beforeEach(() => {
  transport.fetch.mockReset();
  for (const key of ["CODEX_CA_CERTIFICATE", "SSL_CERT_FILE", "REQUEST_METHOD"]) {
    vi.stubEnv(key, undefined);
  }
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
    vi.stubEnv(key, undefined);
    vi.stubEnv(key.toLowerCase(), undefined);
  }
});

afterEach(() => vi.unstubAllEnvs());

describe("native compaction model policy", () => {
  it.each([
    {
      name: "rejects a same-name model from another provider despite a prepared selected model",
      selectedModel: "shared-model",
      nativeProvider: "other-provider",
      nativeModel: "shared-model",
      prepared: true,
      allowed: false,
      revokeSource: false,
    },
    {
      name: "rejects a same-name model from another provider without prepared model evidence",
      selectedModel: "shared-model",
      nativeProvider: "other-provider",
      nativeModel: "shared-model",
      prepared: false,
      allowed: false,
      revokeSource: false,
    },
    {
      name: "allows a prepared same-provider catalog alias for the actual wire model",
      selectedModel: "catalog-model",
      nativeProvider: "allowed-provider",
      nativeModel: "wire-model",
      prepared: true,
      allowed: true,
      revokeSource: false,
    },
    {
      name: "rejects an allowed model at final provider I/O when its original compaction source is revoked",
      selectedModel: "catalog-model",
      nativeProvider: "allowed-provider",
      nativeModel: "wire-model",
      prepared: true,
      allowed: true,
      revokeSource: true,
    },
  ])(
    "$name",
    async ({ selectedModel, nativeProvider, nativeModel, prepared, allowed, revokeSource }) => {
      await withStateDirEnv("openclaw-compact-model-policy-", async ({ tempRoot }) => {
        const provider = "allowed-provider";
        const threadId = "compaction-policy-thread";
        const turnId = "compaction-policy-turn";
        const runId = randomUUID();
        const identity = {
          kind: "session" as const,
          agentId: "main",
          sessionId: "compaction-policy-session",
          sessionKey: "agent:main:compaction-policy",
        };
        const controller = new AbortController();
        let sourceActive = true;
        const host = await createAgentHarnessHostCapabilitiesForTest({
          pluginId: "codex",
          nativeModelPolicySupport: "exact",
          attempt: {
            runId,
            agentId: identity.agentId,
            sessionId: identity.sessionId,
            sessionKey: identity.sessionKey,
            workspaceDir: tempRoot,
            agentDir: path.join(tempRoot, "agent"),
            provider,
            modelId: selectedModel,
            abortSignal: controller.signal,
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
            const request = JSON.parse(line) as { id: number; method: string };
            if (request.method === "thread/compact/start") {
              send({
                method: "turn/started",
                params: { threadId, turn: { id: turnId, status: "inProgress" } },
              });
              send({
                method: "item/started",
                params: {
                  threadId,
                  turnId,
                  item: { id: "policy-compaction-item", type: "contextCompaction" },
                },
              });
              send({ id: request.id, result: {} });
              started.resolve();
            } else if (request.method === "account/read") {
              send({ id: request.id, result: { account: { type: "apiKey" } } });
            } else if (
              request.method === "turn/interrupt" ||
              request.method === "thread/unsubscribe"
            ) {
              send({ id: request.id, result: {} });
            } else {
              send({
                id: request.id,
                error: {
                  code: -32_601,
                  message: `Unexpected policy fixture RPC: ${request.method}`,
                },
              });
            }
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
          if (!inference) {
            throw new Error("Expected a real owned inference qualification");
          }
          assertCodexInferenceRouteConfig(
            harness.client,
            inference.route,
            inference.config,
            nativeProvider,
            inference.providers,
          );
          bindCodexInferenceThread(harness.client, threadId, inference.route, inference.providers);
          if (!(await retainCodexAppServerLiveThread(harness.client, threadId))) {
            throw new Error("Expected a retained compaction subscription");
          }
          const bindingStore = createCodexTestBindingStore();
          await bindingStore.mutate(identity, {
            kind: "set",
            binding: { threadId, cwd: tempRoot, model: nativeModel, modelProvider: nativeProvider },
          });
          const runtimeModel = prepared
            ? {
                ...createCodexTestModel(provider),
                id: selectedModel,
                params: buildCodexRuntimeModelParams(selectedModel, nativeModel),
              }
            : undefined;
          const retainSourceAuthority = host.capabilities.retainSourceAuthority;
          if (!retainSourceAuthority) {
            throw new Error("Expected the production operator source capability");
          }
          pending = maybeCompactCodexAppServerSession(
            {
              ...identity,
              runId,
              sessionFile: path.join(tempRoot, "session.jsonl"),
              workspaceDir: tempRoot,
              provider,
              model: selectedModel,
              runtimeModel,
              trigger: "manual",
              abortSignal: controller.signal,
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
          expect(response.status === 200, "native compaction model admission").toBe(forwarded);
          if (forwarded) {
            expect(await response.text()).toBe("synthetic compaction provider response");
          } else {
            expect(response.status).toBe(403);
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
          harness.send({
            method: "item/completed",
            params: {
              threadId,
              turnId,
              item: { id: "policy-compaction-item", type: "contextCompaction" },
            },
          });
          harness.send({
            method: "turn/completed",
            params: {
              threadId,
              turn: { id: turnId, status: forwarded ? "completed" : "interrupted", items: [] },
            },
          });
          await expect(pending).resolves.toMatchObject({ ok: forwarded, compacted: forwarded });
        } finally {
          harness.send({
            method: "turn/started",
            params: { threadId, turn: { id: turnId, status: "inProgress" } },
          });
          harness.send({
            method: "turn/completed",
            params: { threadId, turn: { id: turnId, status: "interrupted", items: [] } },
          });
          controller.abort();
          await pending?.catch(() => undefined);
          await harness.client.closeAndWait();
          host.close();
        }
      });
    },
  );
});
