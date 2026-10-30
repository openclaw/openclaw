import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { attachModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import type { ProviderPlugin } from "../plugins/provider-plugin.types.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import { createDeferredCore } from "../shared/deferred.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { killPidIfAlive, readPidFile } from "../test-utils/process-tree.js";
import { agentProcessTestEntrypoints } from "./process-runtime.test-support.js";
import {
  attachModelProviderLocalService,
  createConfiguredProviderLocalServiceAcquirer,
  ensureModelProviderLocalService,
  ensureProviderLocalService,
  getManagedProviderLocalServiceDiagnosticsForTest,
  stopManagedProviderLocalServices,
} from "./provider-local-service.js";
import {
  createProviderLocalServiceTestFixture,
  ONE_SHOT_HOST_READY_KIND,
  waitForReadyOneShotHostExit,
} from "./provider-local-service.test-support.js";
import { hasManagedProviderLocalServices } from "./provider-runtime-lifecycle.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

type LocalService = Parameters<typeof attachModelProviderLocalService>[1];
const baseUrl = (port: number) => `http://127.0.0.1:${port}/v1`;
function localService(port: number, overrides: Partial<LocalService> = {}): LocalService {
  return {
    command: process.execPath,
    args: [
      "-e",
      `require("node:http").createServer((req,res)=>res.end("ok")).listen(${port},"127.0.0.1");`,
    ],
    healthUrl: `${baseUrl(port)}/models`,
    readyTimeoutMs: 5_000,
    idleStopMs: 1,
    ...overrides,
  };
}

function scriptService(port: number, script: string, overrides: Partial<LocalService> = {}) {
  return localService(port, { args: ["-e", script], ...overrides });
}

function serviceTarget(port: number, providerId: string, service: LocalService) {
  return { providerId, baseUrl: baseUrl(port), service };
}

function serviceModel(port: number, provider: string, service = localService(port)) {
  return attachModelProviderLocalService(
    makeProviderModelFixture<"openai-completions">({
      id: "demo",
      provider,
      api: "openai-completions",
      baseUrl: baseUrl(port),
    }),
    service,
  );
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function verifyOneShotExit(
  target: ReturnType<typeof serviceTarget>,
  body: string,
  pidPath: string,
  signal?: AbortSignal,
) {
  const moduleUrl = resolveRuntimeWorkerUrl(agentProcessTestEntrypoints.providerLocalService);
  const script = [
    `import fs from "node:fs";`,
    `import { ensureProviderLocalService, getManagedProviderLocalServiceDiagnosticsForTest } from ${JSON.stringify(moduleUrl.href)};`,
    `if (!process.send) throw new Error("missing one-shot host IPC");`,
    `process.on("disconnect", () => {});`,
    `const target = ${JSON.stringify(target)};`,
    body,
    `process.send({ kind: ${JSON.stringify(ONE_SHOT_HOST_READY_KIND)} });`,
  ].join("\n");
  const parent = spawn(
    process.execPath,
    [...resolveRuntimeWorkerArgv(moduleUrl).slice(0, -1), "--input-type=module", "-e", script],
    { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  parent.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  let pid: number | undefined;
  try {
    const exited = waitForReadyOneShotHostExit(parent, () => stderr);
    expect(signal ? await withinTest(exited, signal) : await exited, stderr).toEqual({
      code: 0,
      signal: null,
    });
    pid = await readPidFile(pidPath);
    if (signal) {
      // One-shot exit handlers cannot join their service's extinction.
      while (isPidAlive(pid)) {
        await waitForProcessTick(10, undefined, { signal });
      }
      expect(isPidAlive(pid)).toBe(false);
    }
  } finally {
    killPidIfAlive(parent.pid);
    killPidIfAlive(pid ?? (await readPidFile(pidPath).catch(() => undefined)));
  }
}

function configuredAcquirer(
  providerId: string,
  configuredUrl: string,
  service: LocalService,
  baseURL?: string,
) {
  const provider = { baseUrl: configuredUrl, baseURL, models: [], localService: service };
  return createConfiguredProviderLocalServiceAcquirer(() => ({
    models: { providers: { [providerId]: provider } },
  }));
}

async function listen(server: net.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing test server port");
  }
  return address.port;
}

async function waitForProbeFailure(url: string): Promise<void> {
  await expect
    .poll(async () => !(await fetch(url).catch(() => null)), { timeout: 2_000, interval: 50 })
    .toBe(true);
}

async function withSpawnReadyHealthProbe<T>(run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    try {
      return await realFetch(input, init);
    } catch (initialError) {
      const requestUrl = input instanceof Request ? input.url : input.toString();
      const spawned = getManagedProviderLocalServiceDiagnosticsForTest().some(
        (diagnostics) => diagnostics.healthUrl === requestUrl && diagnostics.pid !== undefined,
      );
      if (!spawned || init?.signal?.aborted) {
        throw initialError;
      }

      // Production probes before and after spawn. Once diagnostics prove the
      // fixture child exists, wait for its real socket instead of its 250ms retry.
      const deadline = Date.now() + 1_000;
      let latestError = initialError;
      while (Date.now() < deadline) {
        await waitForProcessTick(5);
        try {
          return await realFetch(input, init);
        } catch (error) {
          latestError = error;
          if (init?.signal?.aborted) {
            break;
          }
        }
      }
      throw latestError;
    }
  });

  try {
    return await run();
  } finally {
    fetchSpy.mockRestore();
  }
}

describe("provider local service", () => {
  const fixture = createProviderLocalServiceTestFixture();
  const tempDirs = createTempDirTracker();
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fixture.cleanup();
    tempDirs.cleanup();
  });

  it("starts an on-demand local service and stops it after idle", async () => {
    const port = await fixture.claimPort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const reconcile = vi.fn<NonNullable<ProviderPlugin["reconcileLocalService"]>>(async () => {
      expect((await fetch(healthUrl)).ok).toBe(true);
    });
    const model = attachModelProviderRuntimePluginHandle(serviceModel(port, "local-demo"), {
      plugin: { reconcileLocalService: reconcile },
    } as never);

    const acquire = (signal?: AbortSignal) =>
      ensureModelProviderLocalService(model, undefined, signal);
    const firstLease = expectDefined(
      await withSpawnReadyHealthProbe(acquire),
      "Expected first lease",
    );
    const secondLease = expectDefined(await acquire(), "Expected second lease");
    reconcile.mockImplementationOnce(() => {
      throw new Error("reconcile failed");
    });
    await expect(acquire()).rejects.toThrow("reconcile failed");
    const controller = new AbortController();
    const abort = new Error("reconcile aborted");
    reconcile.mockImplementationOnce(async ({ signal }) => {
      controller.abort(abort);
      throw signal?.reason;
    });
    await expect(acquire(controller.signal)).rejects.toThrow(abort.message);

    const reconciliation = createDeferredCore();
    const reconcileStarted = createDeferredCore();
    const lateController = new AbortController();
    const lateAbort = new Error("late reconcile abort");
    reconcile.mockImplementationOnce(() => {
      reconcileStarted.resolve();
      return reconciliation.promise;
    });
    const lateAcquire = acquire(lateController.signal);
    await reconcileStarted.promise;
    lateController.abort(lateAbort);
    reconciliation.resolve();
    await expect(lateAcquire).rejects.toThrow(lateAbort.message);

    expect(reconcile).toHaveBeenCalledTimes(5);
    expect((await fetch(healthUrl)).ok).toBe(true);
    firstLease.release();
    firstLease.release();
    expect((await fetch(healthUrl)).ok).toBe(true);
    secondLease.release();
    await waitForProbeFailure(healthUrl);
    await stopManagedProviderLocalServices();
    expect(hasManagedProviderLocalServices()).toBe(false);
  });

  it("resolves process configuration for root and exact legacy baseURL endpoints", async () => {
    const port = await fixture.claimPort();
    const providerId = "gpu-spark";
    const rootBaseUrl = `http://127.0.0.1:${port}`;
    const healthUrl = `${rootBaseUrl}/v1/models`;
    const acquire = configuredAcquirer(providerId, "", localService(port), `127.0.0.1:${port}/V1`);

    const rootLease = await withSpawnReadyHealthProbe(() =>
      acquire({
        providerId,
        baseUrl: rootBaseUrl,
        service: { command: "caller-controlled" },
      } as Parameters<typeof acquire>[0]),
    );
    const configuredLease = await acquire({ providerId, baseUrl: `${rootBaseUrl}/V1` });

    expect(rootLease && configuredLease).toBeDefined();
    expect((await fetch(healthUrl)).ok).toBe(true);
    [rootLease, configuredLease].forEach((lease) => lease?.release());
    await waitForProbeFailure(healthUrl);
  });

  it("allows a default loopback endpoint when provider baseUrl is empty", async () => {
    const port = await fixture.claimPort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const acquire = configuredAcquirer("gpu-default", "", localService(port));

    const lease = await withSpawnReadyHealthProbe(() =>
      acquire({
        providerId: "gpu-default",
        baseUrl: `http://127.0.0.1:${port}/v1`,
      }),
    );

    expect(lease).toBeDefined();
    lease?.release();
    await waitForProbeFailure(healthUrl);
  });

  it.each([
    [
      "plugin-selected probe host",
      "http://127.0.0.1:11434/v1",
      "http://169.254.169.254/latest/meta-data",
    ],
    ["remote endpoint with empty configuration", "", "http://memory.example/v1"],
  ])("rejects %s", async (_label, configuredUrl, requestedUrl) => {
    const acquire = configuredAcquirer("gpu-spark", configuredUrl, {
      command: process.execPath,
      args: ["--version"],
    });
    await expect(acquire({ providerId: "gpu-spark", baseUrl: requestedUrl })).rejects.toThrow(
      "must match models.providers.gpu-spark.baseUrl",
    );
  });

  it("caps oversized local service idle stop timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const port = await fixture.claimPort();
    const model = serviceModel(
      port,
      "local-huge-idle",
      localService(port, { idleStopMs: Number.MAX_SAFE_INTEGER }),
    );

    try {
      const lease = await withSpawnReadyHealthProbe(() => ensureModelProviderLocalService(model));

      expectDefined(lease, "Expected local service lease").release();

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("sends provider request headers on local service health probes", async () => {
    const port = await fixture.claimPort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const model = serviceModel(
      port,
      "local-auth",
      scriptService(
        port,
        `const http=require("http");http.createServer((req,res)=>{if(req.headers.authorization!=="Bearer health-secret"||req.headers["x-tenant"]!=="acme"){res.writeHead(401);res.end("unauthorized");return;}res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true}');}).listen(${port},"127.0.0.1");`,
        { healthUrl: undefined },
      ),
    );

    const sentinel = mintSecretSentinel("health-secret", { label: "local-health-probe" });
    const lease = await withSpawnReadyHealthProbe(() =>
      ensureModelProviderLocalService(model, {
        Authorization: `Bearer ${sentinel}`,
        "X-Tenant": "acme",
      }),
    );

    expectDefined(lease, "Expected local service lease");
    expect((await fetch(healthUrl)).status).toBe(401);
    expect(
      (
        await fetch(healthUrl, {
          headers: { Authorization: "Bearer health-secret", "X-Tenant": "acme" },
        })
      ).ok,
    ).toBe(true);
    lease?.release();
    await waitForProbeFailure(healthUrl);
  });

  it("rejects unknown sentinels before starting a local service", async () => {
    const port = await fixture.claimPort();
    const unknown = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";
    const model = serviceModel(port, "local-unknown-auth", {
      command: process.execPath,
      args: ["--version"],
      readyTimeoutMs: 1_000,
    });

    await expect(
      ensureModelProviderLocalService(model, { Authorization: `Bearer ${unknown}` }),
    ).rejects.toThrow(
      `Secret sentinel ${unknown} is not registered in this process; refusing to check local model provider health`,
    );
  });

  it("reconciles a healthy external process and cancels its health response body", async () => {
    let socketClosed = false;
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      // Consume the request so graceful close is observable; keep the response unfinished.
      socket.resume();
      socket.on("error", () => undefined);
      socket.on("close", () => {
        sockets.delete(socket);
        socketClosed = true;
      });
      socket.write(
        ["HTTP/1.1 200 OK", "Content-Type: application/json", "", '{"ok":true}'].join("\r\n"),
      );
    });
    const port = await listen(server);
    const reconcile = vi.fn(async () => undefined);
    const model = attachModelProviderRuntimePluginHandle(
      serviceModel(
        port,
        "local-body-cleanup",
        localService(port, { args: ["--version"], readyTimeoutMs: 1_000 }),
      ),
      { plugin: { reconcileLocalService: reconcile } } as never,
    );

    try {
      const lease = await ensureModelProviderLocalService(model);
      expect(lease).toBeDefined();
      expect(reconcile).toHaveBeenCalledOnce();
      lease?.release();
      await expect.poll(() => socketClosed, { timeout: 1000, interval: 20 }).toBe(true);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeServer(server);
    }
  });

  it("serializes concurrent chat and embedding starts with independent leases", async () => {
    const port = await fixture.claimPort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const startsPath = path.join(tempDirs.make("openclaw-local-service-"), "starts.txt");
    const service = scriptService(
      port,
      `const fs=require("node:fs");const http=require("node:http");fs.appendFileSync(${JSON.stringify(
        startsPath,
      )},"start\\n");setTimeout(()=>{const server=http.createServer((req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true}');});server.listen(${port},"127.0.0.1");process.on("SIGTERM",()=>server.close(()=>process.exit(0)));},100);`,
    );
    const [chatLease, embeddingLease] = await withSpawnReadyHealthProbe(() =>
      Promise.all([
        ensureModelProviderLocalService(serviceModel(port, "local-concurrent", service)),
        ensureProviderLocalService(serviceTarget(port, "local-concurrent", service)),
      ]),
    );

    expect(chatLease).toBeDefined();
    expect(embeddingLease).toBeDefined();
    expect((await fetch(healthUrl)).ok).toBe(true);
    embeddingLease?.release();
    expect((await fetch(healthUrl)).ok).toBe(true);
    chatLease?.release();
    await waitForProbeFailure(healthUrl);
    const starts = (await fs.readFile(startsPath, "utf8")).trim().split("\n");
    expect(starts).toHaveLength(1);
  });

  it("keeps configured provider aliases on different local endpoints independent", async () => {
    const firstPort = await fixture.claimPort([0, 1]);
    const secondPort = firstPort + 1;
    const firstHealthUrl = `http://127.0.0.1:${firstPort}/v1/models`;
    const secondHealthUrl = `http://127.0.0.1:${secondPort}/v1/models`;
    const startsPath = path.join(tempDirs.make("openclaw-local-service-key-"), "starts.txt");
    const args = [
      "-e",
      `const fs=require("node:fs");const http=require("node:http");fs.appendFileSync(process.env.STARTS_PATH,process.env.LOCAL_SERVICE_PORT+"\\n");const server=http.createServer((req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true}');});server.listen(Number(process.env.LOCAL_SERVICE_PORT),"127.0.0.1");process.on("SIGTERM",()=>server.close(()=>process.exit(0)));`,
    ];
    const makeService = (port: number) =>
      localService(port, {
        args,
        env: { LOCAL_SERVICE_PORT: String(port), STARTS_PATH: startsPath },
        healthUrl: undefined,
      });

    const leases = await withSpawnReadyHealthProbe(() =>
      Promise.all([
        ensureProviderLocalService(
          serviceTarget(firstPort, "ollama-spark", makeService(firstPort)),
        ),
        ensureProviderLocalService(
          serviceTarget(secondPort, "ollama-studio", makeService(secondPort)),
        ),
      ]),
    );

    expect((await fetch(firstHealthUrl)).ok).toBe(true);
    expect((await fetch(secondHealthUrl)).ok).toBe(true);
    for (const lease of leases) {
      lease?.release();
    }
    await Promise.all([waitForProbeFailure(firstHealthUrl), waitForProbeFailure(secondHealthUrl)]);
    const starts = (await fs.readFile(startsPath, "utf8")).trim().split("\n").toSorted();
    expect(starts).toEqual([String(firstPort), String(secondPort)].toSorted());
  });

  it("restarts an OpenClaw-managed local service when its health endpoint is down", async () => {
    const port = await fixture.claimPort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const tempDir = tempDirs.make("openclaw-local-service-restart-");
    const startsPath = path.join(tempDir, "starts.txt");
    const statusPath = path.join(tempDir, "status.txt");
    const forkedPidPath = path.join(tempDir, "forked.pid");
    let firstForkedPid: number | undefined;
    const model = serviceModel(
      port,
      "local-restart",
      scriptService(
        port,
        `const fs=require("node:fs");const http=require("node:http");const {spawn}=require("node:child_process");const fork=spawn(process.execPath,["-e","setInterval(() => {}, 1000)"],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(
          forkedPidPath,
        )},String(fork.pid));fs.appendFileSync(${JSON.stringify(
          startsPath,
        )},"start\\n");fs.writeFileSync(${JSON.stringify(
          statusPath,
        )},"ok");const server=http.createServer((req,res)=>{const status=fs.readFileSync(${JSON.stringify(
          statusPath,
        )},"utf8");if(status.trim()!=="ok"){res.writeHead(503);res.end("not ready");return;}res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true}');});server.listen(${port},"127.0.0.1");process.on("SIGTERM",()=>server.close(()=>process.exit(0)));`,
        { idleStopMs: 0 },
      ),
    );

    try {
      const firstLease = await withSpawnReadyHealthProbe(() =>
        ensureModelProviderLocalService(model),
      );
      firstLease?.release();
      expect((await fetch(healthUrl)).ok).toBe(true);
      firstForkedPid = await readPidFile(forkedPidPath);

      await fs.writeFile(statusPath, "down", "utf8");
      expect((await fetch(healthUrl)).status).toBe(503);

      const secondLease = await ensureModelProviderLocalService(model);
      expect((await fetch(healthUrl)).ok).toBe(true);
      // Replacement acquisition joins the retired process tree before spawning anew.
      expect(isPidAlive(firstForkedPid)).toBe(false);
      expectDefined(secondLease, "Expected restarted local service lease").release();

      const starts = (await fs.readFile(startsPath, "utf8")).trim().split("\n");
      expect(starts).toHaveLength(2);
    } finally {
      killPidIfAlive(firstForkedPid);
    }
  });

  it.each([
    ["signal SIGTERM", "process.kill(process.pid, 'SIGTERM')", true],
    [
      "code 17; stderr: startup-😀-failure",
      [
        `const bytes=Buffer.from("startup-😀-failure","utf8");`,
        `const split=Buffer.byteLength("startup-","utf8")+2;`,
        `process.stderr.write(bytes.subarray(0,split));`,
        `setTimeout(()=>process.stderr.write(bytes.subarray(split),()=>process.exit(17)),75);`,
      ].join(""),
      false,
    ],
  ] as const)(
    "reports startup exit with %s before readiness timeout",
    async (exit, script, modelRoute) => {
      const port = await fixture.claimPort();
      const service = { command: process.execPath, args: ["-e", script], readyTimeoutMs: 60_000 };
      const startedAt = Date.now();
      await expect(
        modelRoute
          ? ensureModelProviderLocalService(serviceModel(port, "local-exit", service))
          : ensureProviderLocalService(serviceTarget(port, "local-exit", service)),
      ).rejects.toThrow(`local-exit local service exited before readiness with ${exit}`);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    },
  );

  it("does not keep one-shot hosts alive through diagnostic pipes", async ({ signal }) => {
    const port = await fixture.claimPort();
    const servicePidPath = path.join(tempDirs.make("openclaw-local-service-unref-"), "service.pid");
    const target = serviceTarget(port, "local-unref", {
      command: process.execPath,
      args: [
        "-e",
        `const http=require("node:http");const server=http.createServer((req,res)=>{res.writeHead(200);res.end("ok");});server.listen(${port},"127.0.0.1");setInterval(()=>process.stderr.write("tick\\\\n"),10);`,
      ],
      readyTimeoutMs: 5000,
    });
    const script = [
      `const lease = await ensureProviderLocalService(target);`,
      `const [diagnostics] = getManagedProviderLocalServiceDiagnosticsForTest();`,
      `if (Buffer.byteLength(diagnostics.stderrTail) > 8192) throw new Error("unbounded runtime output");`,
      `await fs.promises.writeFile(${JSON.stringify(servicePidPath)}, String(diagnostics.pid));`,
      `lease?.release();`,
    ].join("\n");
    await verifyOneShotExit(target, script, servicePidPath, signal);
  });

  it("does not keep failed one-shot hosts alive through diagnostic pipes", async () => {
    const port = await fixture.claimPort();
    const servicePidPath = path.join(
      tempDirs.make("openclaw-local-service-failed-unref-"),
      "service.pid",
    );
    const failedServiceReadyTimeoutMs = 60_000;
    const serviceScript = [
      `const fs=require("node:fs");`,
      `fs.writeFileSync(${JSON.stringify(servicePidPath)},String(process.pid));`,
      `process.on("SIGTERM",()=>{});`,
      `setInterval(()=>process.stderr.write("tick\\n"),10);`,
    ].join("");
    const target = serviceTarget(port, "local-failed-unref", {
      command: process.execPath,
      args: ["-e", serviceScript],
      readyTimeoutMs: failedServiceReadyTimeoutMs,
    });
    // Advance only the nested host's readiness clock after the service PID exists.
    // This preserves live-child failure cleanup without spending the deadline in wall time.
    const script = [
      `const realNow = performance.now.bind(performance);`,
      `const realSetTimeout = globalThis.setTimeout.bind(globalThis);`,
      `let clockOffsetMs = 0;`,
      `performance.now = () => realNow() + clockOffsetMs;`,
      `globalThis.setTimeout = (callback, delay, ...args) => {`,
      `  if (clockOffsetMs === 0 && fs.existsSync(${JSON.stringify(servicePidPath)})) {`,
      `    return realSetTimeout(() => {`,
      `      clockOffsetMs = ${failedServiceReadyTimeoutMs + 1};`,
      `      globalThis.setTimeout = realSetTimeout;`,
      `      callback(...args);`,
      `    }, 0);`,
      `  }`,
      `  return realSetTimeout(callback, delay, ...args);`,
      `};`,
      `try {`,
      `  await ensureProviderLocalService(target);`,
      `} catch (error) {`,
      `  if (!(error instanceof Error) || !error.message.includes("did not become ready")) throw error;`,
      `}`,
      `if (clockOffsetMs === 0) throw new Error("test clock did not advance");`,
    ].join("\n");
    await verifyOneShotExit(target, script, servicePidPath);
  });

  it("honors request aborts while waiting for local service readiness", async () => {
    const port = await fixture.claimPort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const controller = new AbortController();
    const target = serviceTarget(
      port,
      "local-abort",
      scriptService(
        port,
        `const http=require("node:http");setTimeout(()=>{const server=http.createServer((req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true}');});server.listen(${port},"127.0.0.1");process.on("SIGTERM",()=>server.close(()=>process.exit(0)));},2000);`,
        { readyTimeoutMs: 60_000 },
      ),
    );

    const startedAt = Date.now();
    const abortTimer = setTimeout(() => controller.abort(new Error("request aborted")), 100);
    abortTimer.unref?.();

    await expect(ensureProviderLocalService(target, controller.signal)).rejects.toThrow(
      "request aborted",
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await waitForProbeFailure(healthUrl);
  });

  it("reports only bounded redacted startup diagnostics", async () => {
    const port = await fixture.claimPort();
    const diagnosticSecret = "local-service-diagnostic-secret";
    const inheritedDiagnosticSecret = "inherited-local-service-diagnostic-secret";
    const headerDiagnosticSecret = "header-local-service-diagnostic-secret";
    const argumentDiagnosticSecret = "argument-local-service-diagnostic-secret";
    let startupError: Error | undefined;
    vi.stubEnv("INHERITED_DIAGNOSTIC_TOKEN", inheritedDiagnosticSecret);
    const service = localService(port, {
      args: [
        "-e",
        `const http=require("node:http");const noise="x".repeat(9000);const server=http.createServer((req,res)=>{process.stderr.write(noise+" "+process.env.DIAGNOSTIC_SECRET+" "+process.env.INHERITED_DIAGNOSTIC_TOKEN+" "+process.argv[1]+" "+req.headers.authorization);res.writeHead(503,{"connection":"close"});res.end("not ready");server.close();setTimeout(()=>process.exit(17),20);});server.listen(${port},"127.0.0.1");`,
        argumentDiagnosticSecret,
      ],
      env: { DIAGNOSTIC_SECRET: diagnosticSecret },
    });

    try {
      await ensureProviderLocalService({
        ...serviceTarget(port, "local-diagnostics", service),
        headers: { Authorization: `Bearer ${headerDiagnosticSecret}` },
      });
    } catch (error) {
      startupError = error instanceof Error ? error : new Error(String(error));
    }

    expect(startupError?.message).toContain(
      "local-diagnostics local service exited before readiness with code 17",
    );
    expect(startupError?.message).toContain("[redacted]");
    expect(startupError?.message).not.toContain(diagnosticSecret);
    expect(startupError?.message).not.toContain(inheritedDiagnosticSecret);
    expect(startupError?.message).not.toContain(headerDiagnosticSecret);
    expect(startupError?.message).not.toContain(argumentDiagnosticSecret);
    expect(Buffer.byteLength(startupError?.message ?? "")).toBeLessThanOrEqual(8 * 1024 + 256);
    expect(getManagedProviderLocalServiceDiagnosticsForTest()).toEqual([]);
  });

  it("does not spawn a local service after its last startup caller aborts", async () => {
    const pidPath = path.join(tempDirs.make("openclaw-local-service-abort-"), "child.pid");
    const controller = new AbortController();
    let probeCount = 0;
    let childPid: number | undefined;
    const server = http.createServer((_request, response) => {
      probeCount += 1;
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("not ready");
    });
    const port = await listen(server);
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const model = serviceModel(port, "local-abort-before-spawn", {
      command: process.execPath,
      args: [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000);`,
      ],
      healthUrl,
      readyTimeoutMs: 60_000,
    });
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await realFetch(...args);
      if (response.status === 503 && !controller.signal.aborted) {
        controller.abort(new Error("request aborted after unhealthy probe"));
      }
      return response;
    });

    try {
      await expect(
        ensureModelProviderLocalService(model, undefined, controller.signal),
      ).rejects.toThrow("request aborted after unhealthy probe");
      await waitForProcessTick(200);
      childPid = await readPidFile(pidPath).catch(() => undefined);

      expect(probeCount).toBe(1);
      expect(childPid).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
      childPid ??= await readPidFile(pidPath).catch(() => undefined);
      killPidIfAlive(childPid);
      await closeServer(server);
    }
  });
});
