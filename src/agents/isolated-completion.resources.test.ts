import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { getAiTransportHost } from "@openclaw/ai";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../plugins/test-helpers/fs-fixtures.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { withEnvAsync } from "../test-utils/env.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { runIsolatedCompletion } from "./isolated-completion.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import { ModelRegistry } from "./sessions/model-registry.js";

it.each(["overlap", "callback-tail", "cancel-tail", "auth-tail", "auth-failure"] as const)(
  "retains standalone isolated completion resources through %s",
  async (mode) => {
    const roots = createSyncSuiteTempRootTracker("isolated-completion-resources");
    const root = fs.realpathSync(roots.makeTempDir());
    const providerDir = path.join(root, "provider");
    fs.mkdirSync(providerDir);
    const fixture = createColdPluginFixture({
      rootDir: providerDir,
      pluginId: "isolated-resource-fixture",
      providerId: "isolated-resource-provider",
    });
    const workStarted = createDeferred();
    const finishWork = createDeferred();
    const actualWork: Promise<unknown>[] = [];
    const authFailure = new Error("fixture runtime auth unavailable");
    const callbackFailure = new Error("fixture response callback failed");
    const cancelFailure = new Error("fixture stream cancellation failed");
    let authCalls = 0;
    let authWorkSignal: AbortSignal | undefined;
    let authWorkFinished = false;
    let normalDrainRegistryMatches: boolean | undefined;
    const globalKey = `__isolatedAuthWork_${path.basename(root)}`;
    Object.defineProperty(globalThis, globalKey, {
      configurable: true,
      value: () => {
        if (++authCalls !== 1) {
          return;
        }
        if (mode === "auth-tail" || mode === "auth-failure") {
          authWorkSignal = getAsyncWorkSignal();
          const selectedRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
          authWorkSignal?.addEventListener(
            "abort",
            () => {
              normalDrainRegistryMatches =
                getPluginRuntimeGatewayRequestScope()?.pluginRegistry === selectedRegistry;
            },
            { once: true },
          );
          const pending = trackAsyncWork(async () => {
            workStarted.resolve();
            await finishWork.promise;
            authWorkSignal?.throwIfAborted();
            authWorkFinished = true;
          });
          actualWork.push(pending);
          void pending.catch(() => {});
          if (mode === "auth-failure") {
            throw authFailure;
          }
        }
      },
    });
    fs.writeFileSync(
      fixture.runtimeSource,
      `module.exports = { id: ${JSON.stringify(fixture.pluginId)}, register(api) {
        api.registerProvider({
          id: ${JSON.stringify(fixture.providerId)}, label: "Isolated resources", auth: [],
          async prepareRuntimeAuth() { globalThis[${JSON.stringify(globalKey)}](); }
        });
      } };`,
    );
    const requests: ServerResponse[] = [];
    const arrivals = [createDeferred(), createDeferred(), createDeferred()];
    let finishing = false;
    const finishResponse = (response: ServerResponse, index: number) => {
      if (response.destroyed || response.writableEnded) {
        return;
      }
      writeOpenAiResponsesSse(response, [
        {
          id: "isolated-response",
          object: "chat.completion.chunk",
          model: "isolated-model",
          choices: [{ index: 0, delta: { content: `reply-${index}` }, finish_reason: "stop" }],
        },
      ]);
    };
    const server = createServer((request, response) => {
      request.resume();
      const index = requests.push(response) - 1;
      arrivals[index]?.resolve();
      if (finishing) {
        finishResponse(response, index);
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const calls: Promise<unknown>[] = [];
    const spies: Array<{ mockRestore(): void }> = [];
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Isolated completion fixture has no TCP port");
      }
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: root, model: `${fixture.providerId}/isolated-model` } },
        models: {
          providers: {
            [fixture.providerId]: {
              api: "openai-completions",
              apiKey: "synthetic-isolated-key",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              models: [
                {
                  id: "isolated-model",
                  name: "Isolated model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 1024,
                },
              ],
            },
          },
        },
        plugins: {
          load: { paths: [fixture.rootDir] },
          slots: { memory: "none" },
          entries: { [fixture.pluginId]: { enabled: true } },
        },
      };
      await withEnvAsync(
        {
          ...createColdPluginHermeticEnv(root, { bundledPluginsDir: roots.makeTempDir() }),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: path.join(root, "state"),
        },
        async () => {
          expect(getAsyncWorkSignal()).toBeUndefined();
          const create = vi.spyOn(ModelRegistry, "create");
          const fork = vi.spyOn(ModelRegistry.prototype, "fork");
          spies.push(create, fork);
          if (mode === "callback-tail" || mode === "cancel-tail") {
            const { configureAiTransportRuntimeHost } =
              await import("./ai-transport-runtime-host.js");
            configureAiTransportRuntimeHost();
            const pluginHost = getAiTransportHost().plugin;
            const wrap = pluginHost.wrapSimpleCompletionStream;
            let responses = 0;
            spies.push(
              vi.spyOn(pluginHost, "wrapSimpleCompletionStream").mockImplementation((params) => {
                const stream = wrap(params) ?? params.context.streamFn;
                return (model, context, options) =>
                  stream(model, context, {
                    ...options,
                    onResponse: async (response, responseModel) => {
                      await options?.onResponse?.(response, responseModel);
                      if (++responses !== 1) {
                        return;
                      }
                      if (mode === "cancel-tail") {
                        throw callbackFailure;
                      }
                      workStarted.resolve();
                      const pending = finishWork.promise;
                      actualWork.push(pending);
                      await pending;
                    },
                  });
              }),
            );
            if (mode === "cancel-tail") {
              const realFetch = globalThis.fetch;
              let wrapped = false;
              spies.push(
                vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
                  const response = await realFetch(...args);
                  if (wrapped || !response.url.startsWith(`http://127.0.0.1:${address.port}/`)) {
                    return response;
                  }
                  wrapped = true;
                  const reader = response.body?.getReader();
                  if (!reader) {
                    throw new Error("Isolated fixture response has no body");
                  }
                  return new Response(
                    new ReadableStream<Uint8Array>({
                      async pull(controller) {
                        const { value, done } = await reader.read();
                        if (done) {
                          controller.close();
                        } else {
                          controller.enqueue(value);
                        }
                      },
                      async cancel(reason) {
                        workStarted.resolve();
                        const pending = (async () => {
                          try {
                            await finishWork.promise;
                            throw cancelFailure;
                          } finally {
                            await reader.cancel(reason);
                          }
                        })();
                        actualWork.push(pending);
                        return await pending;
                      },
                    }),
                    { status: response.status, headers: response.headers },
                  );
                }),
              );
            }
          }
          const start = (signal?: AbortSignal) => {
            const pending = runIsolatedCompletion({
              config: cfg,
              provider: fixture.providerId,
              model: "isolated-model",
              agentId: "main",
              agentHarnessRuntimeOverride: "openclaw",
              systemPrompt: "Return a short reply.",
              prompt: "Fixture input",
              timeoutMs: 10_000,
              abortSignal: signal,
            });
            calls.push(pending);
            return pending;
          };
          const waitForRequest = (index: number, call: Promise<unknown>) =>
            Promise.race([
              arrivals[index]!.promise,
              call.then(() => {
                throw new Error("Completion ended before the expected provider request");
              }),
            ]);
          const abortReason = new Error("fixture isolated caller aborted");
          const controller = new AbortController();
          const first = start(mode === "callback-tail" ? controller.signal : undefined);
          if (mode === "auth-failure") {
            await expect(first).rejects.toBe(authFailure);
            await workStarted.promise;
            expect(requests).toHaveLength(0);
          } else {
            await waitForRequest(0, first);
            if (mode !== "overlap") {
              finishResponse(requests[0]!, 0);
              if (mode === "callback-tail" || mode === "cancel-tail") {
                await Promise.race([
                  workStarted.promise,
                  first.then(() => {
                    throw new Error("Completion ended before its accepted work started");
                  }),
                ]);
              }
              if (mode === "callback-tail") {
                controller.abort(abortReason);
                await expect(first).rejects.toBe(abortReason);
              } else if (mode === "cancel-tail") {
                await expect(first).rejects.toMatchObject({ code: "output-rejected" });
              } else {
                await expect(first).resolves.toMatchObject({ text: "reply-0" });
                await workStarted.promise;
              }
            }
          }
          if (mode === "auth-tail" || mode === "auth-failure") {
            expect.soft(authWorkSignal?.aborted ?? false).toBe(false);
          }
          const firstBuilds = create.mock.calls.length;
          expect(firstBuilds).toBeGreaterThan(0);
          const secondIndex = mode === "auth-failure" ? 0 : 1;
          const second = start();
          await waitForRequest(secondIndex, second);
          expect.soft(create.mock.calls.length).toBe(firstBuilds);
          expect(fork.mock.calls.length).toBe(2);
          expect(fork.mock.calls[0]![0] === fork.mock.calls[1]![0]).toBe(false);
          finishWork.resolve();
          await Promise.allSettled(actualWork);
          if (mode === "auth-tail" || mode === "auth-failure") {
            expect.soft(authWorkFinished).toBe(true);
          }
          if (mode === "overlap") {
            finishResponse(requests[0]!, 0);
            await expect(first).resolves.toMatchObject({ text: "reply-0" });
          }
          finishResponse(requests[secondIndex]!, secondIndex);
          await expect(second).resolves.toMatchObject({ text: `reply-${secondIndex}` });
          const thirdIndex = secondIndex + 1;
          const third = start();
          await waitForRequest(thirdIndex, third);
          expect(create.mock.calls.length).toBe(firstBuilds + 1);
          finishResponse(requests[thirdIndex]!, thirdIndex);
          await expect(third).resolves.toMatchObject({ text: `reply-${thirdIndex}` });
          if (authWorkSignal) {
            expect(normalDrainRegistryMatches).toBe(true);
          }
        },
      );
    } finally {
      finishWork.resolve();
      finishing = true;
      requests.forEach(finishResponse);
      await Promise.allSettled(calls);
      await Promise.allSettled(actualWork);
      for (const spy of spies) {
        spy.mockRestore();
      }
      await resetPreparedModelRuntimeSnapshotsForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      clearPluginMetadataLifecycleCaches();
      resetPluginLoaderTestStateForTest();
      Reflect.deleteProperty(globalThis, globalKey);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      roots.cleanup();
    }
  },
);
