import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { getAiTransportHost } from "@openclaw/ai";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../plugins/test-helpers/fs-fixtures.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { withEnvAsync } from "../test-utils/env.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import * as modelResolution from "./embedded-agent-runner/model.js";
import { createModelExecAutoReviewer } from "./exec-auto-reviewer.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import { ModelRegistry } from "./sessions/model-registry.js";
import { acquireSimpleCompletionModelForAgent } from "./simple-completion-runtime.js";

// The reviewed command is input data only; this fixture never dispatches it.
const input = {
  command: "git status",
  host: "gateway" as const,
  reason: "approval-required" as const,
  analysis: { parsed: true, allowlistMatched: false, inlineEval: false },
};

it.each(["overlap", "late-preparation", "callback-tail", "cancel-tail"] as const)(
  "retains the exec reviewer model through %s",
  async (mode) => {
    const roots = createSyncSuiteTempRootTracker("exec-reviewer-resources");
    const root = fs.realpathSync(roots.makeTempDir());
    fs.mkdirSync(path.join(root, "provider"));
    const fixture = createColdPluginFixture({
      rootDir: path.join(root, "provider"),
      pluginId: "reviewer-fixture",
      providerId: "reviewer-provider",
    });
    fs.writeFileSync(
      fixture.runtimeSource,
      `module.exports = { id: "reviewer-fixture", register(api) { api.registerProvider({ id: "reviewer-provider", label: "Reviewer fixture", auth: [] }); } };`,
    );
    const arrived = createDeferred();
    const heldWorkStarted = createDeferred();
    const finishWork = createDeferred();
    const requests: ServerResponse[] = [];
    const finish = (response: ServerResponse) => {
      if (response.destroyed || response.writableEnded) {
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: "review", object: "chat.completion.chunk", model: "reviewer", choices: [{ index: 0, delta: { content: JSON.stringify({ decision: "ask", risk: "low", rationale: "fixture" }) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    };
    const server = createServer((_request, response) => {
      requests.push(response);
      arrived.resolve();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Fixture server has no TCP port");
    }
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: root, model: `${fixture.providerId}/reviewer` } },
      models: {
        providers: {
          [fixture.providerId]: {
            api: "openai-completions",
            apiKey: "fixture-only",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            models: [
              {
                id: "reviewer",
                name: "Reviewer",
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
    try {
      await withEnvAsync(
        {
          ...createColdPluginHermeticEnv(root, { bundledPluginsDir: roots.makeTempDir() }),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: path.join(root, "state"),
        },
        async () => {
          const parent = new AsyncWorkScope();
          const create = vi.spyOn(ModelRegistry, "create");
          const realResolve = modelResolution.resolveModelAsync;
          const resolver = vi.spyOn(modelResolution, "resolveModelAsync");
          let transportSpy: { mockRestore(): void } | undefined;
          let fetchSpy: { mockRestore(): void } | undefined;
          let first: Promise<unknown> | undefined;
          let drain: Promise<void> | undefined;
          let drained = false;
          if (mode === "late-preparation") {
            resolver.mockImplementationOnce(async (...args) => {
              const prepared = await realResolve(...args);
              heldWorkStarted.resolve();
              await finishWork.promise;
              return prepared;
            });
          }
          if (mode === "callback-tail" || mode === "cancel-tail") {
            const { configureAiTransportRuntimeHost } =
              await import("./ai-transport-runtime-host.js");
            configureAiTransportRuntimeHost();
            const host = getAiTransportHost().plugin;
            const wrap = host.wrapSimpleCompletionStream;
            transportSpy = vi
              .spyOn(host, "wrapSimpleCompletionStream")
              .mockImplementation((params) => {
                const stream = wrap(params) ?? params.context.streamFn;
                return (model, context, options) =>
                  stream(model, context, {
                    ...options,
                    onResponse: async (response, responseModel) => {
                      await options?.onResponse?.(response, responseModel);
                      if (mode === "cancel-tail") {
                        throw new Error("fixture callback failure");
                      }
                      heldWorkStarted.resolve();
                      await finishWork.promise;
                    },
                  });
              });
          }
          if (mode === "cancel-tail") {
            const realFetch = globalThis.fetch;
            fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
              const response = await realFetch(...args);
              if (!response.url.startsWith(`http://127.0.0.1:${address.port}/`)) {
                return response;
              }
              const reader = response.body?.getReader();
              if (!reader) {
                throw new Error("Fixture response has no body");
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
                    heldWorkStarted.resolve();
                    try {
                      await finishWork.promise;
                    } finally {
                      await reader.cancel(reason);
                    }
                  },
                }),
                { status: response.status, headers: response.headers },
              );
            });
          }
          const acquire = () =>
            acquireSimpleCompletionModelForAgent({
              cfg,
              agentId: "main",
              allowMissingApiKeyModes: ["aws-sdk"],
            });
          try {
            const reviewer = createModelExecAutoReviewer({
              cfg,
              agentId: "main",
              reviewer: { timeoutMs: 5000 },
            });
            first = parent.track(() => reviewer(input));
            const started = mode === "late-preparation" ? heldWorkStarted.promise : arrived.promise;
            await Promise.race([
              started,
              first.then(() => {
                throw new Error("Reviewer settled before fixture boundary");
              }),
            ]);
            const builds = create.mock.calls.length;
            expect(builds).toBeGreaterThan(0);
            if (mode === "callback-tail" || mode === "cancel-tail") {
              finish(requests[0]!);
              await heldWorkStarted.promise;
            }
            if (mode !== "overlap") {
              const decision = await first;
              // Only project the public decision; prepared objects include runtime environment data.
              expect(decision).toMatchObject({
                decision: "ask",
                rationale:
                  mode === "cancel-tail"
                    ? "exec reviewer completion failed: fixture callback failure"
                    : "exec reviewer timed out after 5000ms",
              });
              drain = parent.drain().then(() => {
                drained = true;
              });
            }
            const second = await acquire();
            if ("error" in second) {
              throw new Error("Second fixture preparation failed");
            }
            try {
              expect.soft(create.mock.calls.length).toBe(builds);
              if (mode !== "overlap") {
                expect.soft(drained).toBe(false);
              }
            } finally {
              second.release();
            }
            finishWork.resolve();
            if (mode === "overlap") {
              finish(requests[0]!);
            }
            await first;
            await parent.drain();
            await drain;
            if (mode === "late-preparation") {
              expect(requests.length).toBe(0);
            }
            const after = await acquire();
            if ("error" in after) {
              throw new Error("Final fixture preparation failed");
            }
            try {
              expect(create.mock.calls.length).toBe(builds + 1);
            } finally {
              after.release();
            }
          } finally {
            finishWork.resolve();
            requests.forEach(finish);
            await first?.catch(() => {});
            await parent.drain();
            await drain;
            transportSpy?.mockRestore();
            fetchSpy?.mockRestore();
            resolver.mockRestore();
            create.mockRestore();
            await resetPreparedModelRuntimeSnapshotsForTest();
            clearRuntimeAuthProfileStoreSnapshots();
            clearPluginMetadataLifecycleCaches();
            resetPluginLoaderTestStateForTest();
          }
        },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      roots.cleanup();
    }
  },
);
