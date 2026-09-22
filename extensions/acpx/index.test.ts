import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginHookReplyDispatchResult } from "./runtime-api.js";
import setupPlugin from "./setup-api.js";

const { createAcpxRuntimeServiceMock, tryDispatchAcpReplyHookMock } = vi.hoisted(() => ({
  createAcpxRuntimeServiceMock: vi.fn(),
  tryDispatchAcpReplyHookMock: vi.fn(),
}));

vi.mock("./register.runtime.js", () => ({
  createAcpxRuntimeService: createAcpxRuntimeServiceMock,
}));

vi.mock("openclaw/plugin-sdk/acp-runtime-backend", () => ({
  tryDispatchAcpReplyHook: tryDispatchAcpReplyHookMock,
}));

import plugin from "./index.js";

type AcpxAutoEnableProbe = Parameters<OpenClawPluginApi["registerAutoEnableProbe"]>[0];

function registerAcpxAutoEnableProbe(): AcpxAutoEnableProbe {
  const probes: AcpxAutoEnableProbe[] = [];
  setupPlugin.register(
    createTestPluginApi({
      registerAutoEnableProbe(probe) {
        probes.push(probe);
      },
    }),
  );
  const probe = probes[0];
  if (!probe) {
    throw new Error("expected ACPX setup plugin to register an auto-enable probe");
  }
  return probe;
}

describe("acpx plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the runtime service and reply_dispatch hook", () => {
    const service = { id: "acpx-service", start: vi.fn() };
    createAcpxRuntimeServiceMock.mockReturnValue(service);
    const openKeyedStore = vi.fn();

    const api = createTestPluginApi({
      pluginConfig: { stateDir: "/tmp/acpx" },
      runtime: { state: { openKeyedStore } } as never,
      registerService: vi.fn(),
      on: vi.fn(),
    });

    plugin.register(api);

    expect(createAcpxRuntimeServiceMock).toHaveBeenCalledWith({
      pluginConfig: api.pluginConfig,
      openKeyedStore: expect.any(Function),
    });
    const params = createAcpxRuntimeServiceMock.mock.calls[0]?.[0] as {
      openKeyedStore: typeof openKeyedStore;
    };
    params.openKeyedStore({ namespace: "test", maxEntries: 1 });
    expect(openKeyedStore).toHaveBeenCalledWith({ namespace: "test", maxEntries: 1 });
    expect(api.registerService).toHaveBeenCalledWith(service);
    expect(api.on).toHaveBeenCalledWith("reply_dispatch", expect.any(Function), {
      eligibleDispatchKinds: ["acp"],
    });
  });

  it("does not touch runtime state while registering metadata-only plugin APIs", () => {
    const service = { id: "acpx-service", start: vi.fn() };
    createAcpxRuntimeServiceMock.mockReturnValue(service);

    const api = createTestPluginApi({
      pluginConfig: {},
      runtime: {} as never,
      registerService: vi.fn(),
      on: vi.fn(),
    });

    expect(() => plugin.register(api)).not.toThrow();
    expect(api.registerService).toHaveBeenCalledWith(service);
  });

  it("preserves the ACP reply_dispatch runtime path through the registered hook", async () => {
    const service = { id: "acpx-service", start: vi.fn() };
    createAcpxRuntimeServiceMock.mockReturnValue(service);
    tryDispatchAcpReplyHookMock.mockResolvedValue({
      handled: true,
      queuedFinal: true,
      counts: { tool: 1, block: 0, final: 1 },
    });

    const on = vi.fn();
    const openKeyedStore = vi.fn();
    const api = createTestPluginApi({
      pluginConfig: { stateDir: "/tmp/acpx" },
      runtime: { state: { openKeyedStore } } as never,
      registerService: vi.fn(),
      on,
    });

    plugin.register(api);

    const hook = on.mock.calls.find(([hookName]) => hookName === "reply_dispatch")?.[1];
    if (!hook) {
      throw new Error("expected reply_dispatch hook to be registered");
    }

    const event = {
      ctx: { raw: "reply ctx" },
      runId: "run-1",
      sessionKey: "agent:test:session",
      inboundAudio: false,
      shouldRouteToOriginating: false,
      shouldSendToolSummaries: true,
      shouldSendFullToolDetails: false,
      sendPolicy: "allow",
    };
    const ctx = {
      cfg: {},
      dispatcher: { dispatch: vi.fn(), getQueuedCounts: vi.fn(), getFailedCounts: vi.fn() },
      recordProcessed: vi.fn(),
      markIdle: vi.fn(),
    };

    await expect(hook(event, ctx)).resolves.toEqual({
      handled: true,
      queuedFinal: true,
      counts: { tool: 1, block: 0, final: 1 },
    });
    expect(tryDispatchAcpReplyHookMock).toHaveBeenCalledWith(event, ctx);
  });

  it.each([
    { timeoutSeconds: undefined, finish: "complete" },
    { timeoutSeconds: 180, finish: "complete" },
    { timeoutSeconds: undefined, finish: "cancel" },
    { timeoutSeconds: 180, finish: "cancel" },
  ])(
    "keeps the ACP turn alive beyond operation timeout $timeoutSeconds until $finish",
    async ({ timeoutSeconds, finish }) => {
      vi.useFakeTimers();
      try {
        const service = { id: "acpx-service", start: vi.fn() };
        createAcpxRuntimeServiceMock.mockReturnValue(service);
        const turn = createDeferred<PluginHookReplyDispatchResult>();
        const completed = {
          handled: true,
          queuedFinal: true,
          counts: { tool: 0, block: 0, final: 1 },
        };
        const cancelled = {
          handled: true,
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        };
        tryDispatchAcpReplyHookMock.mockImplementation(
          async (_event, hookCtx: { abortSignal?: AbortSignal }) => {
            const onAbort = () => turn.resolve(cancelled);
            hookCtx.abortSignal?.addEventListener("abort", onAbort, { once: true });
            try {
              return await turn.promise;
            } finally {
              hookCtx.abortSignal?.removeEventListener("abort", onAbort);
            }
          },
        );

        const on = vi.fn();
        const api = createTestPluginApi({
          pluginConfig: timeoutSeconds === undefined ? {} : { timeoutSeconds },
          runtime: { state: { openKeyedStore: vi.fn() } } as never,
          registerService: vi.fn(),
          on,
        });

        plugin.register(api);

        const registration = on.mock.calls.find(([hookName]) => hookName === "reply_dispatch");
        const hook = registration?.[1];
        if (!hook) {
          throw new Error("expected reply_dispatch hook to be registered");
        }

        const controller = new AbortController();
        const run = hook(
          {
            ctx: { raw: "reply ctx" },
            runId: "run-1",
            sessionKey: "agent:test:session",
            inboundAudio: false,
            shouldRouteToOriginating: false,
            shouldSendToolSummaries: true,
            shouldSendFullToolDetails: false,
            sendPolicy: "allow",
          },
          {
            cfg: {},
            abortSignal: controller.signal,
            dispatcher: { dispatch: vi.fn(), getQueuedCounts: vi.fn(), getFailedCounts: vi.fn() },
            recordProcessed: vi.fn(),
            markIdle: vi.fn(),
          },
        );
        let settled = false;
        void run.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync((timeoutSeconds ?? 120) * 1000 + 10_000);

        expect(settled).toBe(false);
        expect(registration?.[2]?.timeoutMs).toBeUndefined();
        if (finish === "cancel") {
          controller.abort();
        } else {
          turn.resolve(completed);
        }
        await expect(run).resolves.toEqual(finish === "cancel" ? cancelled : completed);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("declares setup auto-enable reasons for ACPX-owned ACP config", () => {
    const probe = registerAcpxAutoEnableProbe();

    expect(probe({ config: { acp: { enabled: true } }, env: {} })).toBe("ACP runtime configured");
    expect(probe({ config: { acp: { backend: "acpx" } }, env: {} })).toBe("ACP runtime configured");
    expect(probe({ config: { acp: { enabled: true, backend: "custom-runtime" } }, env: {} })).toBe(
      null,
    );
  });
});
