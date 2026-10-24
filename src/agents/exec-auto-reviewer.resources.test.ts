import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { getAiTransportHost } from "@openclaw/ai";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listenProvider } from "../gateway/gateway-provider-fixture.test-support.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../plugins/test-helpers/fs-fixtures.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import * as modelResolution from "./embedded-agent-runner/model.js";
import { createModelExecAutoReviewer } from "./exec-auto-reviewer.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import { ModelRegistry } from "./sessions/model-registry.js";
import { acquireSimpleCompletionModelForAgent } from "./simple-completion-runtime.js";

// Resource-lifetime probes review this command as data; the fallback probe dispatches a fixture.
const input = {
  command: "git status",
  host: "gateway" as const,
  reason: "approval-required" as const,
  analysis: { parsed: true, allowlistMatched: false, inlineEval: false },
};

it.for(["overlap", "late-preparation", "callback-tail", "cancel-tail", "fallback"] as const)(
  "retains the exec reviewer model through %s",
  async (mode, testContext) => {
    if (mode === "cancel-tail" && process.versions.bun) {
      // Restore this probe when transformed Fetch bodies forward cancellation under Bun.
      testContext.skip();
    }
    const timesOut = mode === "late-preparation" || mode === "callback-tail";
    const roots = createSyncSuiteTempRootTracker("exec-resource-probe");
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
    const requestedModels: string[] = [];
    let fixtureDecision: "allow" | "deny" | "ask" = "ask";
    let cancelAtBackup: (() => void) | undefined;
    const finish = (response: ServerResponse) => {
      if (response.destroyed || response.writableEnded) {
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: "review", object: "chat.completion.chunk", model: "reviewer", choices: [{ index: 0, delta: { content: JSON.stringify({ decision: fixtureDecision, risk: "low", rationale: "fixture" }) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    };
    const server = createServer((request, response) => {
      requests.push(response);
      if (mode === "fallback") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          const model = JSON.parse(body).model as string;
          requestedModels.push(model);
          if (model === "reviewer") {
            response.writeHead(503, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "fixture provider unavailable" } }));
          } else {
            cancelAtBackup?.();
            finish(response);
          }
        });
        return;
      }
      arrived.resolve();
    });
    const baseUrl = await listenProvider(server);
    const origin = new URL(baseUrl).origin;
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: root, model: `${fixture.providerId}/reviewer` } },
      models: {
        providers: {
          [fixture.providerId]: {
            api: "openai-completions",
            apiKey: "fixture-only",
            baseUrl,
            models: ["reviewer", "backup"].map((id) => ({
              id,
              name: id,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 1024,
            })),
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
          const create = vi.spyOn(ModelRegistry, "fromCapturedSources");
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
              if (!response.url.startsWith(`${origin}/`)) {
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
          const acquire = async () => {
            const prepared = await acquireSimpleCompletionModelForAgent({
              cfg,
              agentId: "main",
              allowMissingApiKeyModes: ["aws-sdk"],
            });
            if ("error" in prepared) {
              throw new Error("Fixture preparation failed");
            }
            return prepared;
          };
          try {
            if (mode === "fallback") {
              saveExecApprovals({
                version: 1,
                defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
                agents: {},
              });
              for (const scenario of ["allow", "deny", "ask", "cancel"] as const) {
                requestedModels.length = 0;
                fixtureDecision = scenario === "cancel" ? "allow" : scenario;
                const controller = new AbortController();
                cancelAtBackup = scenario === "cancel" ? () => controller.abort() : undefined;
                const marker = path.join(root, `${scenario}.txt`);
                const script = path.join(root, `${scenario}.cjs`);
                fs.writeFileSync(
                  script,
                  `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");process.stdout.write("EFFECT_OK");`,
                );
                const quote = (value: string) =>
                  `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
                const command = `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(script)}`;
                const tool = createExecTool({
                  config: cfg,
                  agentId: "main",
                  host: "gateway",
                  mode: "auto",
                  safeBins: [],
                  cwd: root,
                  nonInteractiveApproval: true,
                  notifyOnExit: false,
                  allowBackground: false,
                  preparedSubagentExecution: false,
                  preparedStoreEnvironment: {},
                  reviewer: {
                    timeoutMs: 5000,
                    model: {
                      primary: `${fixture.providerId}/reviewer`,
                      fallbacks: [`${fixture.providerId}/backup`],
                    },
                  },
                });
                first = parent.track(() =>
                  tool.execute(`fallback-${scenario}`, { command }, controller.signal),
                );
                if (scenario === "allow") {
                  const result = await first;
                  expect(result, JSON.stringify(result)).toMatchObject({
                    details: { status: "completed", exitCode: 0 },
                  });
                  expect(fs.readFileSync(marker, "utf8")).toBe("executed");
                } else if (scenario === "cancel") {
                  await expect(first).rejects.toThrow();
                } else {
                  await expect(first).resolves.toMatchObject({
                    details: {
                      status: "failed",
                      failureKind: scenario === "deny" ? "auto-review-denied" : "approval_required",
                    },
                  });
                }
                expect(requestedModels[0]).toBe("reviewer");
                expect(requestedModels.at(-1)).toBe("backup");
                expect(requestedModels.filter((model) => model === "backup")).toHaveLength(1);
              }
              await parent.drain();
              for (const scenario of ["deny", "ask", "cancel"]) {
                expect(fs.existsSync(path.join(root, `${scenario}.txt`))).toBe(false);
              }
              return;
            }
            const reviewer = createModelExecAutoReviewer({
              cfg,
              agentId: "main",
              reviewer: { timeoutMs: 5000 },
            });
            if (timesOut) {
              vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            }
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
              if (timesOut) {
                await vi.advanceTimersByTimeAsync(5000);
              }
              const decision = await first;
              if (timesOut) {
                vi.useRealTimers();
              }
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
            try {
              expect.soft(create.mock.calls.length).toBe(builds);
              if (mode !== "overlap") {
                expect.soft(drained).toBe(false);
              }
            } finally {
              await second[Symbol.asyncDispose]();
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
            try {
              expect(create.mock.calls.length).toBe(builds + 1);
            } finally {
              await after[Symbol.asyncDispose]();
            }
          } finally {
            if (timesOut) {
              vi.useRealTimers();
            }
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
            if (mode === "fallback") {
              resetProcessRegistryForTests();
              await closeOpenClawStateDatabaseAsync();
            }
          }
        },
      );
    } finally {
      server.closeAllConnections();
      await promisify(server.close.bind(server))();
      roots.cleanup();
    }
  },
);
