import assert from "node:assert/strict";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { parseBenchmarkInteger, runBenchmarkEntrypoint } from "./lib/benchmark-harness.mts";

await runBenchmarkEntrypoint("bench-isolated-completion-worker", async () => {
  const requests = parseBenchmarkInteger(process.argv[2] ?? "50", "requests", 2, 1000);
  const root = process.env.HOME;
  assert(root && dirname(root) === realpathSync(tmpdir()));
  assert(basename(root).startsWith("openclaw-isolated-bench-"));
  const stateDir = join(root, "state");
  assert.equal(process.env.OPENCLAW_STATE_DIR, stateDir);
  const provider = "isolated-benchmark";
  const model = "isolated-model";
  const sockets = new Set<Socket>();
  let connections = 0;
  let received = 0;
  let fixtureError: Error | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer test-key");
      assert.equal(body.model, model);
      assert.equal(body.stream, true);
      assert(!body.tools?.length, "Isolated completion must not expose tools");
      received++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          id: "chatcmpl-isolated-benchmark",
          object: "chat.completion.chunk",
          created: 0,
          model,
          choices: [
            { index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        })}\n\ndata: [DONE]\n\n`,
      );
    })().catch((error: unknown) => {
      fixtureError = new Error("Isolated loopback request failed", { cause: error });
      response.writeHead(500).end();
    });
  });
  server.keepAliveTimeout = 30_000;
  server.on("connection", (socket) => {
    connections++;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const cfg: OpenClawConfig = {
    plugins: { enabled: false },
    agents: {
      defaults: {
        workspace: join(root, "workspace"),
        skipBootstrap: true,
        model: { primary: `${provider}/${model}` },
      },
    },
    models: {
      mode: "replace",
      providers: {
        [provider]: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "test-key",
          api: "openai-completions",
          agentRuntime: { id: "openclaw" },
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: model,
              name: model,
              api: "openai-completions",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_000,
              maxTokens: 8_192,
            },
          ],
        },
      },
    },
  };
  const memoryBefore = process.memoryUsage();
  let peakRssBytes = memoryBefore.rss;
  const sampleMemory = () => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  };
  const sampler = setInterval(sampleMemory, 5);
  const cpuBefore = process.cpuUsage();
  const observationsMs: number[] = [];
  const settledMs: number[] = [];
  const dispatchMs: number[] = [];
  let resetConfigRuntimeState: (() => void) | undefined;
  let result: Record<string, unknown> | undefined;
  try {
    const importStarted = performance.now();
    // No application imports or fixture-state helpers precede this timer. Acquisition
    // stays inside runIsolatedCompletion; pre-acquiring would erase the cold path.
    const { runIsolatedCompletion } = await import("../src/agents/isolated-completion.js");
    const { AsyncWorkScope } = await import("../src/shared/async-work-scope.js");
    const runtime = await import("../src/config/runtime-snapshot.js");
    resetConfigRuntimeState = runtime.resetConfigRuntimeState;
    const moduleImportMs = performance.now() - importStarted;
    runtime.setRuntimeConfigSnapshot(cfg);
    for (let index = 0; index < requests; index++) {
      const failures = new Set<unknown>();
      const scope = new AsyncWorkScope(failures);
      let completion: Awaited<ReturnType<typeof runIsolatedCompletion>> | undefined;
      const started = performance.now();
      try {
        completion = await scope.run((): ReturnType<typeof runIsolatedCompletion> =>
          runIsolatedCompletion({
            config: cfg,
            provider,
            model,
            agentId: "main",
            agentDir: join(stateDir, "agents", "main", "agent"),
            workspaceDir: join(root, "workspace"),
            systemPrompt: "Return ok.",
            prompt: "Synthetic benchmark input.",
            timeoutMs: 5_000,
            onRequestComplete: (duration) => dispatchMs.push(duration),
          }),
        );
        observationsMs.push(performance.now() - started);
      } finally {
        // A logical result can precede cleanup. Join its owning scope before the
        // next request so warm samples cannot borrow unfinished preparation.
        await AsyncWorkScope.runWhenAllIdle(
          () => [scope],
          () => scope.drain(),
        );
      }
      settledMs.push(performance.now() - started);
      // Draining uses allSettled; idle alone does not prove successful release.
      assert.equal(failures.size, 0, "Isolated completion cleanup failed");
      assert.equal(scope.hasPendingWork, false);
      assert(completion);
      assert.equal(completion.text, "ok");
      assert.deepEqual(completion.owner, { kind: "harness", id: "openclaw" });
      assert.equal(completion.usage?.input, 3);
      assert.equal(completion.usage?.output, 1);
      assert.equal(received, index + 1);
      assert.equal(dispatchMs.length, index + 1);
      sampleMemory();
    }
    if (fixtureError) {
      throw fixtureError;
    }
    const cpu = process.cpuUsage(cpuBefore);
    result = {
      workload: "isolated-completion",
      requests,
      connections,
      moduleImportMs,
      observationsMs,
      settledMs,
      dispatchMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      memoryBefore,
      memoryAfter: process.memoryUsage(),
      peakRssBytes,
      inputTokens: requests * 3,
      outputTokens: requests,
      cleanupFailures: 0,
    };
  } finally {
    clearInterval(sampler);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { closeProviderTransportDispatcherPool } =
        await import("../src/agents/provider-transport-dispatcher-pool.js");
      const { getGlobalDispatcher } = await import("undici");
      const { cleanupSessionStateForTest } =
        await import("../src/test-utils/session-state-cleanup.js");
      const closed = [...sockets].map((socket) => once(socket, "close"));
      await Promise.race([
        Promise.all([
          ...closed,
          closeProviderTransportDispatcherPool(),
          getGlobalDispatcher().close(),
        ]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Isolated transport teardown exceeded 1000ms")),
            1000,
          );
        }),
      ]);
      assert.equal(sockets.size, 0);
      await cleanupSessionStateForTest({ stateDir, rootPath: root });
      resetConfigRuntimeState?.();
      if (result) {
        result.socketsAfterPoolClose = sockets.size;
        result.memoryAfterDrain = process.memoryUsage();
      }
    } finally {
      clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
  console.log(`[bench-isolated-completion-result] ${JSON.stringify(result)}`);
});
