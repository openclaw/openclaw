import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { json } from "node:stream/consumers";
import { closeQaRuntimeStores } from "openclaw/plugin-sdk/qa-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { runQaGatewayFixture, stopQaGatewayFixture } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import type { QaGatewayChildListeningContext } from "./gateway-child-setup.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { resolveQaNodeExecPath } from "./node-exec.js";
import { attachQaMockResponsesWebSocketServer } from "./providers/mock-openai/mock-openai-responses-websocket.js";
import { MockResponseStream } from "./providers/mock-openai/mock-openai-stream.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const PLUGIN_ID = "qa-deferred-startup-provider";
const MODEL_ID = "qa-deferred-startup-model";

// Opt-in Gateway proof keeps the real 120-second deadline. Unit tests own its clock matrix.
it(
  "admits deferred agents after finite slow preparation and prevents publication after shutdown",
  {
    timeout: 300_000,
  },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-deferred-publication-"));
    const pluginDir = path.join(root, "plugin");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: PLUGIN_ID,
        providers: ["mock-openai"],
        providerCatalogEntry: "./catalog.js",
        activation: { onStartup: false },
        configSchema: { type: "object", properties: {}, additionalProperties: false },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "index.js"),
      `export default { id: ${JSON.stringify(PLUGIN_ID)}, register() {} };\n`,
    );
    await fs.writeFile(
      path.join(pluginDir, "catalog.js"),
      `
import { setTimeout as sleep } from "node:timers/promises";
export default {
  id: "mock-openai", label: "Synthetic deferred startup", auth: [],
  staticCatalog: { order: "simple", async run({ signal }) {
    const started = Date.now();
    console.log("QA_DEFERRED_STATIC " + JSON.stringify({ phase: "started", started }));
    try { await sleep(130_000, undefined, { signal }); }
    catch (error) {
      console.log("QA_DEFERRED_STATIC " + JSON.stringify({ phase: "aborted", elapsedMs: Date.now() - started }));
      throw error;
    }
    console.log("QA_DEFERRED_STATIC " + JSON.stringify({ phase: "completed", elapsedMs: Date.now() - started }));
    return { provider: {
      baseUrl: "http://127.0.0.1", api: "openai-responses",
      models: [{ id: ${JSON.stringify(MODEL_ID)}, name: "Synthetic deferred model", reasoning: false,
        input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000, maxTokens: 1024 }]
    }};
  }}
};
`,
    );
    let requests = 0;
    const dispatch = async ({ body }: { body: Record<string, unknown> }) => {
      const ordinal = ++requests;
      const stream = new MockResponseStream(`resp_deferred_${ordinal}`);
      stream.message({
        id: `msg_deferred_${ordinal}`,
        text: "SYNTHETIC_DEFERRED_STARTUP_OK",
        phase: "final_answer",
      });
      return {
        events: stream.complete(4),
        model: typeof body.model === "string" ? body.model : "",
      };
    };
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const { events } = await dispatch({
          body: (await json(request)) as Record<string, unknown>,
        });
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
        );
      })().catch(() => response.writeHead(500).end());
    });
    const sockets = attachQaMockResponsesWebSocketServer({ server, dispatch });
    await once(server.listen(0, "127.0.0.1"), "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Synthetic inference did not bind");
    }
    const providerBaseUrl = `http://127.0.0.1:${address.port}/v1`;
    const owners: ReturnType<typeof createQaGatewayChild>[] = [];
    await runQaGatewayFixture(
      async () => {
        const start = async (
          onListening: (context: QaGatewayChildListeningContext) => Promise<void>,
        ) => {
          // Seed through the public session owner, then close it before child admission.
          const fixtureRoot = path.join(root, randomUUID());
          const storePath = path.join(
            fixtureRoot,
            "state",
            "agents",
            "qa",
            "agent",
            "openclaw-agent.sqlite",
          );
          await upsertSessionEntry({
            agentId: "qa",
            env: { ...process.env, OPENCLAW_STATE_DIR: path.join(fixtureRoot, "state") },
            sessionKey: "agent:qa:startup-seed",
            storePath,
            entry: { sessionId: randomUUID(), updatedAt: Date.now() },
          });
          await closeQaRuntimeStores(fixtureRoot);
          // A restored byte-for-byte copy must earn its own startup integrity admission.
          await fs.copyFile(storePath, `${storePath}.restored`);
          await fs.rename(`${storePath}.restored`, storePath);
          const owner = createQaGatewayChild();
          owners.push(owner);
          const starting = owner.start({
            repoRoot: REPO_ROOT,
            command: {
              executablePath: await resolveQaNodeExecPath(),
              argsPrefix: [path.join(REPO_ROOT, "dist/index.js")],
              cwd: REPO_ROOT,
              usePackagedPlugins: false,
              tempParentDir: process.env.TMPDIR,
            },
            providerBaseUrl,
            transportBaseUrl: "",
            providerMode: "mock-openai",
            primaryModel: `mock-openai/${MODEL_ID}`,
            alternateModel: `mock-openai/${MODEL_ID}`,
            forcedRuntime: "openclaw",
            runtimeSelection: "configured",
            controlUiEnabled: false,
            onListening,
            mutateConfig: (config) => ({
              ...config,
              session: { store: storePath },
              skills: { workshop: { autonomous: { mode: "off" } } },
              models: {
                ...config.models,
                providers: {
                  ...config.models?.providers,
                  "mock-openai": { ...config.models!.providers!["mock-openai"]!, models: [] },
                },
              },
              plugins: {
                ...config.plugins,
                allow: [...(config.plugins?.allow ?? []), PLUGIN_ID],
                load: { paths: [pluginDir] },
                entries: { ...config.plugins?.entries, [PLUGIN_ID]: { enabled: true } },
              },
            }),
          });
          return { owner, starting };
        };
        const { owner, starting } = await start(async (context) => {
          await expect
            .poll(() => context.logs().includes('QA_DEFERRED_STATIC {"phase":"started"'), {
              timeout: 30_000,
            })
            .toBe(true);
          const startedAt = Date.now();
          const readiness = async () => {
            const response = await fetch(`${context.baseUrl}/startupz`);
            return (await response.json()) as {
              status: string;
              pendingReason?: string;
            };
          };
          const pending = await readiness();
          console.log(
            "DEFERRED_STARTUP_STAGE " +
              JSON.stringify({ status: pending.status, pendingReason: pending.pendingReason }),
          );
          expect(pending).toMatchObject({
            status: "starting",
            pendingReason: "agent-database-inspection",
          });
          console.log(
            "DEFERRED_STARTUP_STAGE " + JSON.stringify({ deferredPendingObserved: true }),
          );
          await expect
            .poll(
              async () => {
                const status = await readiness();
                return status.status === "starting";
              },
              { timeout: 170_000, interval: 500 },
            )
            .toBe(false);
          const catalogRows = context
            .logs()
            .split("\n")
            .flatMap((line) => {
              const match = /QA_DEFERRED_STATIC (\{.*\})/.exec(line);
              return match ? [JSON.parse(match[1]!) as { phase: string; elapsedMs?: number }] : [];
            });
          console.log(
            "DEFERRED_STARTUP_STAGE " +
              JSON.stringify({
                elapsedMs: Date.now() - startedAt,
                catalogRows,
                recovered: context
                  .logs()
                  .includes("agent database recovered after background inspection and preparation"),
                modelTimeout: context.logs().includes("model runtime build timed out"),
                backgroundFailure: context
                  .logs()
                  .includes("background model runtime publication failed"),
              }),
          );
          await expect
            .poll(() => context.logs().includes('QA_DEFERRED_STATIC {"phase":"completed"'), {
              timeout: 30_000,
            })
            .toBe(true);
        });
        const gateway = await starting;
        console.log("DEFERRED_STARTUP_OWNER " + JSON.stringify({ pid: gateway.pid }));
        expect(gateway.logs()).toContain('QA_DEFERRED_STATIC {"phase":"completed"');
        expect(gateway.logs()).toContain(
          "agent database recovered after background inspection and preparation",
        );
        const started = (await gateway.call("chat.send", {
          sessionKey: `agent:qa:deferred-proof-${randomUUID()}`,
          message: "Finish the synthetic startup proof.",
          deliver: false,
          idempotencyKey: randomUUID(),
        })) as { runId: string; status: string };
        expect(started.status).toBe("started");
        const terminal = (await gateway.call(
          "agent.wait",
          { runId: started.runId, timeoutMs: 60_000 },
          { timeoutMs: 70_000 },
        )) as { status: string };
        expect(terminal.status).toBe("ok");
        await stopQaGatewayFixture(owner);
        owners.splice(owners.indexOf(owner), 1);
        const listening = Promise.withResolvers<QaGatewayChildListeningContext>();
        const release = Promise.withResolvers<void>();
        const cancelled = await start(async (context) => {
          listening.resolve(context);
          await release.promise;
        });
        const cancellationContext = await Promise.race([
          listening.promise,
          cancelled.starting.then(() => {
            throw new Error("Cancellation Gateway unexpectedly finished startup before listening");
          }),
        ]);
        let stopping: ReturnType<typeof cancelled.owner.stop>;
        try {
          await expect
            .poll(
              () => cancellationContext.logs().includes('QA_DEFERRED_STATIC {"phase":"started"'),
              {
                timeout: 30_000,
              },
            )
            .toBe(true);
          stopping = cancelled.owner.stop();
        } finally {
          release.resolve();
        }
        await expect(cancelled.starting).rejects.toThrow();
        const stopped = await stopping;
        expect(stopped.process).toBe("confirmed-stopped");
        expect(stopped.errors).toEqual([]);
        owners.splice(owners.indexOf(cancelled.owner), 1);
        // Unready QA children have a bounded force-stop path. stop() guarantees
        // process quiescence, not a cooperative callback's abort-log completion.
        expect(cancellationContext.logs()).toContain("received SIGTERM; shutting down");
        expect(cancellationContext.logs()).not.toContain('QA_DEFERRED_STATIC {"phase":"completed"');
        expect(cancellationContext.logs()).not.toContain(
          "agent database recovered after background inspection and preparation",
        );
        console.log(
          "DEFERRED_STARTUP_PROOF " +
            JSON.stringify({
              realGateway: true,
              catalog: "public provider discovery fixture",
              realDeadlineMs: 120_000,
              finitePreparationMs: 130_000,
              deferredPendingObserved: true,
              admittedAfterCompletion: true,
              ordinaryTurn: terminal.status,
              shutdownReceived: true,
              shutdownStoppedProcess: true,
              readmissionAfterShutdown: false,
              providerRequests: requests,
              delivery: false,
            }),
        );
      },
      async () => {
        for (const owner of owners.toReversed()) {
          await stopQaGatewayFixture(owner);
        }
      },
      async () => {
        await sockets.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await fs.rm(root, { recursive: true, force: true });
      },
    );
  },
);
