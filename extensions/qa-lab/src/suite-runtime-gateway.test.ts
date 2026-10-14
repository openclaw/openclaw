// Qa Lab tests cover suite runtime gateway plugin behavior.
import { syncBuiltinESMExports } from "node:module";
import timersPromises from "node:timers/promises";
import { promisify } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
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

vi.mock("openclaw/plugin-sdk/qa-runtime", () => ({
  writeGatewayRestartIntentSync: writeGatewayRestartIntentSyncMock,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  writeGatewayRestartIntentSyncMock.mockReset();
  vi.useRealTimers();
});

function createRestartSettleEnv(waitReady: (params: unknown) => Promise<void>) {
  return {
    gateway: { baseUrl: "http://127.0.0.1:43123" },
    transport: { waitReady },
  } as unknown as Pick<QaSuiteRuntimeEnv, "gateway" | "transport">;
}

function createConfigMutationEnv(
  gatewayCall: (method: string, params: unknown, options: unknown) => Promise<unknown>,
) {
  const waitReady = vi.fn(async (_params: { gateway: unknown; timeoutMs: number }) => {});
  const env = {
    gateway: {
      baseUrl: "http://127.0.0.1:43123",
      call: gatewayCall,
    },
    transport: {
      waitReady,
    },
    providerMode: "mock-openai",
    primaryModel: "openai/gpt-5.6-luna",
    alternateModel: "openai/gpt-5.6-luna-mini",
  } as unknown as QaSuiteRuntimeEnv;
  return { env, waitReady };
}

describe("qa suite gateway helpers", () => {
  it("classifies transport readiness failures without replacing typed infrastructure errors", async () => {
    const readinessError = new Error(
      'telegram account "sut" did not become ready; last check error: proxy returned 502',
    );
    const failedEnv = createRestartSettleEnv(async () => {
      throw readinessError;
    });

    const failure = await waitForTransportReady(failedEnv, 1_234).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(QaSuiteInfraError);
    expect(failure).toMatchObject({
      name: "QaSuiteInfraError",
      code: "transport_ready_timeout",
      cause: readinessError,
    });
    if (!(failure instanceof QaSuiteInfraError)) {
      throw failure;
    }
    expect(failure.message).toContain(readinessError.message);

    const typedError = new QaSuiteInfraError("gateway_ready_timeout", "gateway stayed down");
    await expect(
      waitForTransportReady(
        createRestartSettleEnv(async () => {
          throw typedError;
        }),
      ),
    ).rejects.toBe(typedError);
  });

  it("forces an authenticated restart even when the config patch was already applied", async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: { ok: true },
      release,
    });
    writeGatewayRestartIntentSyncMock.mockReturnValue(true);
    const patch = { tools: { codeMode: { enabled: false } } };
    const gatewayCall = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            gateway: { auth: { token: "keep-me" } },
            ...patch,
          },
        };
      }
      if (method === "system.info") {
        return { pid: 43_123 };
      }
      return { ok: true };
    });
    const { env, waitReady } = createConfigMutationEnv(gatewayCall);
    const runtimeEnv = { OPENCLAW_STATE_DIR: "/isolated/qa-gateway" };
    env.gateway.runtimeEnv = runtimeEnv;
    const restartAfterStateMutation = vi.fn();
    env.gateway.restartAfterStateMutation = restartAfterStateMutation;

    const restarting = restartGatewayWithConfigPatch({ env, patch });
    await vi.advanceTimersByTimeAsync(1_750);

    await expect(restarting).resolves.toEqual({ ok: true });
    expect(gatewayCall).toHaveBeenNthCalledWith(1, "config.get", {}, { timeoutMs: 60_000 });
    expect(gatewayCall).toHaveBeenNthCalledWith(2, "system.info", {}, { timeoutMs: 180_000 });
    expect(gatewayCall).toHaveBeenNthCalledWith(
      3,
      "config.patch",
      {
        raw: JSON.stringify(patch, null, 2),
        baseHash: "hash-1",
        restartDelayMs: 1_000,
        replacePaths: ["gateway.controlUi.allowedOrigins"],
      },
      { timeoutMs: 180_000 },
    );
    expect(gatewayCall).toHaveBeenNthCalledWith(
      4,
      "gateway.restart.request",
      { reason: "config.patch", skipDeferral: true },
      { timeoutMs: 180_000 },
    );
    expect(gatewayCall).toHaveBeenCalledTimes(4);
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
    const gatewayCall = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1", config: {} };
      }
      return method === "system.info" ? { pid: 43_123 } : { ok: true };
    });
    const { env, waitReady } = createConfigMutationEnv(gatewayCall);

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

  it("bounds oversized suite gateway JSON responses", async () => {
    let chunksRead = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunksRead === 0) {
            chunksRead += 1;
            controller.enqueue(new TextEncoder().encode('{"payload":"'));
            return;
          }
          if (chunksRead <= 256) {
            chunksRead += 1;
            controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
            return;
          }
          controller.enqueue(new TextEncoder().encode('"}'));
          controller.close();
        },
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({ response, release });

    await expect(fetchJson("http://127.0.0.1:43123/config")).rejects.toThrow(
      "qa-lab-suite-fetch-json: JSON response exceeds 16777216 bytes",
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds stalled suite gateway JSON response bodies", async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockImplementation(async ({ timeoutMs }: { timeoutMs: number }) => {
      let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
            controller.enqueue(new TextEncoder().encode('{"pending":'));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
      setTimeout(() => bodyController?.error(new Error("request timed out")), timeoutMs);
      return { response, release };
    });

    const request = fetchJson("http://127.0.0.1:43123/config", 1_000);
    const rejection = expect(request).rejects.toThrow("request timed out");

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 1_000 }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("cancels failed suite gateway JSON response bodies before releasing their guard", async () => {
    const events: string[] = [];
    const cancelBody = vi.fn(() => {
      events.push("cancel");
      throw new Error("cancel failed");
    });
    const release = vi.fn(async () => {
      events.push("release");
    });
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream<Uint8Array>({
          cancel: cancelBody,
        }),
        { status: 503 },
      ),
      release,
    });

    await expect(fetchJson("http://127.0.0.1:43123/config")).rejects.toThrow(
      "request failed 503: http://127.0.0.1:43123/config",
    );
    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["cancel", "release"]);
  });

  it("retries healthy gateway responses until their guard releases successfully", async () => {
    vi.useFakeTimers();
    const sleep = vi.spyOn(timersPromises, "setTimeout");
    try {
      // Keep the named promise-timer binding on the same fake clock.
      sleep.mockImplementation(promisify(globalThis.setTimeout));
      syncBuiltinESMExports();
      const events: string[] = [];
      const released = createDeferred<void>();
      fetchWithSsrFGuardMock
        .mockResolvedValueOnce({
          response: new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                events.push("first:cancel");
              },
            }),
          ),
          release: async () => {
            events.push("first:release");
            throw new Error("release failed");
          },
        })
        .mockResolvedValueOnce({
          response: new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                events.push("second:cancel");
              },
            }),
          ),
          release: async () => {
            events.push("second:release");
            await released.promise;
          },
        });
      let ready = false;
      const readiness = waitForGatewayHealthy(
        { gateway: { baseUrl: "http://127.0.0.1:43123" } } as never,
        1_000,
      ).then(() => {
        ready = true;
      });

      const settled = readiness.catch(() => undefined);

      try {
        await vi.advanceTimersByTimeAsync(249);
        expect(events).toEqual(["first:cancel", "first:release"]);
        expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
        expect(ready).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(events).toEqual([
          "first:cancel",
          "first:release",
          "second:cancel",
          "second:release",
        ]);
        expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
        expect(ready).toBe(false);

        released.resolve();
        await expect(readiness).resolves.toBeUndefined();
        expect(ready).toBe(true);
      } finally {
        released.resolve();
        await vi.advanceTimersByTimeAsync(1_000);
        await settled;
      }
    } finally {
      sleep.mockRestore();
      vi.useRealTimers();
      syncBuiltinESMExports();
    }
  });

  it("bounds a hung gateway health request by the remaining readiness deadline", async () => {
    vi.useFakeTimers();
    fetchWithSsrFGuardMock.mockImplementation(
      async ({ timeoutMs }: { timeoutMs: number }) =>
        await new Promise((_, reject) => {
          setTimeout(() => reject(new Error("request timed out")), timeoutMs);
        }),
    );

    const readiness = waitForGatewayHealthy(
      { gateway: { baseUrl: "http://127.0.0.1:43123" } } as never,
      1_000,
    );
    const rejection = expect(readiness).rejects.toThrow("timed out after 1000ms");

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 1_000 }),
    );
  });

  it("skips config mutations that would not change the snapshot", async () => {
    const config = {
      tools: {
        profile: "coding",
      },
      agents: {
        entries: { qa: { model: { primary: "openai/gpt-5.6-luna" } } },
      },
      meta: {
        updatedAt: "2026-04-25T10:00:00.000Z",
      },
    };
    const gatewayCall = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1", config };
      }
      throw new Error(`unexpected ${method}`);
    });
    const { env } = createConfigMutationEnv(gatewayCall);

    await expect(
      patchConfig({ env, patch: { tools: { deny: null } }, restartDelayMs: 0 }),
    ).resolves.toEqual({ ok: true, noop: true });
    await expect(
      applyConfig({
        env,
        nextConfig: { tools: config.tools, agents: config.agents },
        restartDelayMs: 0,
      }),
    ).resolves.toEqual({ ok: true, noop: true });
    expect(gatewayCall).toHaveBeenCalledTimes(2);
  });

  it("ignores prototype keys in cleanup config patches", async () => {
    const config = { tools: { profile: "coding" } };
    const gatewayCall = vi.fn(async () => ({ hash: "hash-1", config }));
    const { env } = createConfigMutationEnv(gatewayCall);
    const patch = JSON.parse(
      '{"tools":{"profile":"coding"},"__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}',
    ) as Record<string, unknown>;

    await expect(patchConfig({ env, patch, restartDelayMs: 0 })).resolves.toEqual({
      ok: true,
      noop: true,
    });
    expect(gatewayCall).toHaveBeenCalledOnce();
  });

  it("does not wait for a deferred restart beyond the mutation timeout", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: { ok: true },
      release,
    });
    const gatewayCall = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1", config: { tools: {} } };
      }
      return { ok: true };
    });
    const { env, waitReady } = createConfigMutationEnv(gatewayCall);

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
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("restart boundary")).mockResolvedValue({
      response: { ok: true },
      release,
    });
    const waitReady = vi.fn(async () => {});

    const settling = waitForConfigRestartSettle(createRestartSettleEnv(waitReady), 500, 5_000);

    await vi.advanceTimersByTimeAsync(1_250);
    await settling;

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
    expect(waitReady).toHaveBeenCalledTimes(1);
  });
});
