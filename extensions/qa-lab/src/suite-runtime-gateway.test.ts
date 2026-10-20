import { syncBuiltinESMExports } from "node:module";
import timersPromises from "node:timers/promises";
import { promisify } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QaSuiteInfraError } from "./errors.js";
import {
  applyConfig,
  fetchJson,
  patchConfig,
  restartGatewayWithConfigPatch,
  waitForConfigRestartSettle,
  waitForGatewayHealthy,
  waitForTransportReady,
} from "./suite-runtime-gateway.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const writeGatewayRestartIntentSyncMock = vi.hoisted(() => vi.fn());
const baseUrl = "http://127.0.0.1:43123";
let env: QaSuiteRuntimeEnv;
let gatewayCall: ReturnType<typeof mockGateway>;
let waitReady: ReturnType<typeof vi.fn<(params: unknown) => Promise<void>>>;

vi.mock("openclaw/plugin-sdk/qa-runtime", () => ({
  writeGatewayRestartIntentSync: writeGatewayRestartIntentSyncMock,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

beforeEach(() => {
  gatewayCall = mockGateway();
  waitReady = vi.fn(async () => {});
  env = {
    gateway: { baseUrl, call: gatewayCall },
    transport: { waitReady },
    providerMode: "mock-openai",
    primaryModel: "openai/gpt-5.6-luna",
    alternateModel: "openai/gpt-5.6-luna-mini",
  } as unknown as QaSuiteRuntimeEnv;
});

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  writeGatewayRestartIntentSyncMock.mockReset();
  vi.useRealTimers();
});

function mockGateway(config: Record<string, unknown> = {}) {
  return vi.fn(async (method: string) => {
    if (method === "config.get") {
      return { hash: "hash-1", config };
    }
    return method === "system.info" ? { pid: 43_123 } : { ok: true };
  });
}

function mockHealthyResponse() {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValue({ response: { ok: true }, release });
  return release;
}

function guardedStream(events: string[], name: string, release: () => Promise<void>) {
  return {
    response: new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          events.push(`${name}:cancel`);
        },
      }),
    ),
    release: async () => {
      events.push(`${name}:release`);
      await release();
    },
  };
}

describe("qa suite gateway helpers", () => {
  it("classifies transport readiness failures without replacing typed infrastructure errors", async () => {
    const readinessError = new Error("transport readiness failed: proxy returned 502");
    waitReady.mockRejectedValueOnce(readinessError);
    const failure = await waitForTransportReady(env, 1_234).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(QaSuiteInfraError);
    expect(failure).toMatchObject({
      name: "QaSuiteInfraError",
      code: "transport_ready_timeout",
      cause: readinessError,
      message: expect.stringContaining(readinessError.message),
    });

    const typedError = new QaSuiteInfraError("gateway_ready_timeout", "gateway stayed down");
    waitReady.mockRejectedValueOnce(typedError);
    await expect(waitForTransportReady(env)).rejects.toBe(typedError);
  });

  it("forces an authenticated restart even when the config patch was already applied", async () => {
    vi.useFakeTimers();
    const release = mockHealthyResponse();
    writeGatewayRestartIntentSyncMock.mockReturnValue(true);
    const patch = { tools: { codeMode: { enabled: false } } };
    gatewayCall.mockImplementation(
      mockGateway({ gateway: { auth: { token: "keep-me" } }, ...patch }),
    );
    const runtimeEnv = { OPENCLAW_STATE_DIR: "/isolated/qa-gateway" };
    env.gateway.runtimeEnv = runtimeEnv;
    const restartAfterStateMutation = vi.fn();
    env.gateway.restartAfterStateMutation = restartAfterStateMutation;

    const restarting = restartGatewayWithConfigPatch({ env, patch });
    await vi.advanceTimersByTimeAsync(1_750);

    await expect(restarting).resolves.toEqual({ ok: true });
    const mutationTimeout = { timeoutMs: 180_000 };
    expect(gatewayCall.mock.calls).toEqual([
      ["config.get", {}, { timeoutMs: 60_000 }],
      ["system.info", {}, mutationTimeout],
      [
        "config.patch",
        {
          raw: JSON.stringify(patch, null, 2),
          baseHash: "hash-1",
          restartDelayMs: 1_000,
          replacePaths: ["gateway.controlUi.allowedOrigins"],
        },
        mutationTimeout,
      ],
      ["gateway.restart.request", { reason: "config.patch", skipDeferral: true }, mutationTimeout],
    ]);
    expect(writeGatewayRestartIntentSyncMock).toHaveBeenCalledWith({
      env: runtimeEnv,
      targetPid: 43_123,
      reason: "config.patch",
      intent: { force: true, waitMs: 0 },
    });
    expect(writeGatewayRestartIntentSyncMock).toHaveBeenCalledOnce();
    expect(writeGatewayRestartIntentSyncMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      gatewayCall.mock.invocationCallOrder[2] ?? Number.POSITIVE_INFINITY,
    );
    expect(writeGatewayRestartIntentSyncMock.mock.invocationCallOrder[0]).toBeLessThan(
      gatewayCall.mock.invocationCallOrder[3] ?? Number.NEGATIVE_INFINITY,
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:43123/readyz",
        auditContext: "qa-lab-suite-wait-for-gateway-healthy",
      }),
    );
    expect(waitReady).toHaveBeenCalledWith({
      gateway: env.gateway,
      timeoutMs: expect.any(Number),
    });
    expect(release).toHaveBeenCalled();
    expect(restartAfterStateMutation).not.toHaveBeenCalled();
  });

  it("does not signal a restart when the immediate drain intent cannot be persisted", async () => {
    writeGatewayRestartIntentSyncMock.mockReturnValue(false);

    await expect(
      restartGatewayWithConfigPatch({ env, patch: { tools: { codeMode: { enabled: true } } } }),
    ).rejects.toThrow("could not persist a forced restart intent");
    expect(gatewayCall.mock.calls.map(([method]) => method)).toEqual([
      "config.get",
      "system.info",
      "config.patch",
    ]);
    expect(waitReady).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it.each(["JSON body", "gateway health"] as const)("bounds a stalled %s request", async (kind) => {
    vi.useFakeTimers();
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockImplementation(async ({ timeoutMs }: { timeoutMs: number }) => {
      if (kind === "gateway health") {
        return await new Promise((_, reject) => {
          setTimeout(() => reject(new Error("request timed out")), timeoutMs);
        });
      }
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"pending":'));
            setTimeout(() => controller.error(new Error("request timed out")), timeoutMs);
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
      return { response, release };
    });

    const request =
      kind === "JSON body"
        ? fetchJson(`${baseUrl}/config`, 1_000)
        : waitForGatewayHealthy(env, 1_000);
    const rejection = expect(request).rejects.toThrow(
      kind === "JSON body" ? "request timed out" : "timed out after 1000ms",
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 1_000 }),
    );
    expect(release).toHaveBeenCalledTimes(kind === "JSON body" ? 1 : 0);
  });

  it("cancels failed suite gateway JSON response bodies before releasing their guard", async () => {
    const events: string[] = [];
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            events.push("cancel");
            throw new Error("cancel failed");
          },
        }),
        { status: 503 },
      ),
      release: async () => {
        events.push("release");
      },
    });

    await expect(fetchJson("http://127.0.0.1:43123/config")).rejects.toThrow(
      "request failed 503: http://127.0.0.1:43123/config",
    );
    expect(events).toEqual(["cancel", "release"]);
  });

  it("retries healthy gateway responses until their guard releases successfully", async () => {
    vi.useFakeTimers();
    const sleep = vi.spyOn(timersPromises, "setTimeout");
    const released = createDeferred<void>();
    let settled = Promise.resolve();
    try {
      // Keep the named promise-timer binding on the same fake clock.
      sleep.mockImplementation(promisify(globalThis.setTimeout));
      syncBuiltinESMExports();
      const events: string[] = [];
      fetchWithSsrFGuardMock
        .mockResolvedValueOnce(
          guardedStream(events, "first", async () => {
            throw new Error("release failed");
          }),
        )
        .mockResolvedValueOnce(guardedStream(events, "second", () => released.promise));
      const onReady = vi.fn<() => void>();
      const readiness = waitForGatewayHealthy(env, 1_000).then(onReady);
      settled = readiness.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(249);
      expect(events).toEqual(["first:cancel", "first:release"]);
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      expect(onReady).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(events).toEqual(["first:cancel", "first:release", "second:cancel", "second:release"]);
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
      expect(onReady).not.toHaveBeenCalled();

      released.resolve();
      await expect(readiness).resolves.toBeUndefined();
      expect(onReady).toHaveBeenCalledOnce();
    } finally {
      try {
        released.resolve();
        await vi.advanceTimersByTimeAsync(1_000);
        await settled;
      } finally {
        sleep.mockRestore();
        vi.useRealTimers();
        syncBuiltinESMExports();
      }
    }
  });

  it.each(["unchanged snapshot", "prototype keys"])("skips cleanup writes for %s", async (kind) => {
    const config = {
      tools: { profile: "coding" },
      meta: { updatedAt: "2026-04-25T10:00:00.000Z" },
    };
    gatewayCall.mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1", config };
      }
      throw new Error(`unexpected ${method}`);
    });

    const patch =
      kind === "unchanged snapshot"
        ? { tools: { deny: null } }
        : (JSON.parse(
            '{"tools":{"profile":"coding"},"__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}',
          ) as Record<string, unknown>);
    await expect(patchConfig({ env, patch, restartDelayMs: 0 })).resolves.toEqual({
      ok: true,
      noop: true,
    });
    if (kind === "unchanged snapshot") {
      await expect(
        applyConfig({ env, nextConfig: { tools: config.tools }, restartDelayMs: 0 }),
      ).resolves.toEqual({ ok: true, noop: true });
    }
    expect(gatewayCall).toHaveBeenCalledTimes(kind === "unchanged snapshot" ? 2 : 1);
  });

  it("does not wait for a deferred restart beyond the mutation timeout", async () => {
    mockHealthyResponse();
    gatewayCall.mockImplementation(mockGateway({ tools: {} }));

    await patchConfig({
      env,
      patch: { tools: { deny: ["read"] } },
      restartDelayMs: 300_000,
    });

    expect(waitReady).toHaveBeenCalledWith({
      gateway: env.gateway,
      timeoutMs: 180_000,
    });
  });

  it("keeps polling gateway health instead of sleeping blindly through restart settle", async () => {
    vi.useFakeTimers();
    mockHealthyResponse();
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("restart boundary"));
    const settling = waitForConfigRestartSettle(env, 500, 5_000);

    await vi.advanceTimersByTimeAsync(1_250);
    await settling;

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
    expect(waitReady).toHaveBeenCalledTimes(1);
  });
});
