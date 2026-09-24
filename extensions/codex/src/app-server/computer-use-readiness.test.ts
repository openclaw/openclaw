import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runCodexComputerUseLiveTest,
  type CodexComputerUseRequest,
} from "./computer-use-readiness.js";
import { installCodexComputerUse, readCodexComputerUseStatus } from "./computer-use.js";
import {
  createComputerUseRequest,
  expectRequestMethodNotCalled,
  expectSetupErrorStatus,
  expectStatusFields,
  requestCalls,
  requireRecord,
} from "./computer-use.test-support.js";
import { resolveCodexComputerUseConfig } from "./config.js";
import { createClientHarness, waitForHarnessRequest } from "./test-support.js";

const sharedClientMocks = vi.hoisted(() => ({
  getLeasedSharedCodexAppServerClient: vi.fn(),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
}));

vi.mock("./shared-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared-client.js")>()),
  ...sharedClientMocks,
}));

describe("Codex Computer Use readiness", () => {
  afterEach(() => {
    vi.useRealTimers();
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockReset();
    sharedClientMocks.releaseLeasedSharedCodexAppServerClient.mockReset();
  });

  it("unsubscribes a cancelled readiness probe while another request completes", async () => {
    const fixture = createComputerUseRequest({ installed: true });
    const controller = new AbortController();
    let probeSubscribed = false;
    const harness = createClientHarness({
      onWrite(line, send) {
        const frame = JSON.parse(line) as { id: number; method: string; params?: unknown };
        if (frame.method === "turn/start" || frame.method === "mcpServer/tool/call") {
          return;
        }
        void fixture(frame.method, frame.params).then(
          (result) => {
            if (frame.method === "thread/start") {
              probeSubscribed = true;
            } else if (frame.method === "thread/unsubscribe") {
              probeSubscribed = false;
            }
            send({ id: frame.id, result: result ?? null });
          },
          (error: unknown) =>
            send({
              id: frame.id,
              error: { code: -32000, message: String(error) },
            }),
        );
      },
    });
    const peer = harness.client.request("turn/start", { threadId: "healthy-peer" });
    void peer.catch(() => undefined);
    try {
      const peerStart = await waitForHarnessRequest(harness, "turn/start");
      const readiness = runCodexComputerUseLiveTest({
        client: harness.client,
        request: <T>(
          method: string,
          params?: unknown,
          options?: { timeoutMs?: number; signal?: AbortSignal },
        ) =>
          harness.client.request<T>(method, params, {
            ...options,
            signal: options?.signal ?? controller.signal,
          }),
        config: resolveCodexComputerUseConfig({
          pluginConfig: {
            computerUse: {
              enabled: true,
              marketplaceName: "desktop-tools",
              strictReadiness: true,
              liveTestTimeoutMs: 1_000,
            },
          },
        }),
        signal: controller.signal,
      });
      const rejected = expect(readiness).rejects.toThrow("aborted");
      await waitForHarnessRequest(harness, "mcpServer/tool/call");
      expect(probeSubscribed).toBe(true);

      controller.abort();
      await rejected;

      expect(probeSubscribed).toBe(false);
      expect(harness.stdinDestroyed).toBe(false);
      harness.send({ id: peerStart.id, result: { turn: { id: "healthy-turn" } } });
      await expect(peer).resolves.toEqual({ turn: { id: "healthy-turn" } });
    } finally {
      await harness.client.closeAndWait();
    }
  });

  it.each(["passed", "cancelled", "mcp-error"] as const)(
    "retires a probe client after failed unsubscribe (probe: %s)",
    async (probe) => {
      const cancelled = probe === "cancelled";
      const fixture = createComputerUseRequest({
        installed: true,
        liveTestFailures: probe === "mcp-error" ? 1 : 0,
      });
      const controller = new AbortController();
      const harness = createClientHarness({
        onWrite(line, send) {
          const frame = JSON.parse(line) as { id: number; method: string; params?: unknown };
          if (frame.method === "mcpServer/tool/call" && cancelled) {
            return;
          }
          if (frame.method === "thread/unsubscribe") {
            send({ id: frame.id, error: { code: -32000, message: "unsubscribe failed" } });
            return;
          }
          void fixture(frame.method, frame.params).then(
            (result) => send({ id: frame.id, result: result ?? null }),
            (error: unknown) =>
              send({ id: frame.id, error: { code: -32000, message: String(error) } }),
          );
        },
      });
      try {
        const readiness = runCodexComputerUseLiveTest({
          client: harness.client,
          request: <T>(
            method: string,
            params?: unknown,
            options?: { timeoutMs?: number; signal?: AbortSignal },
          ) =>
            harness.client.request<T>(method, params, {
              ...options,
              signal: options?.signal ?? controller.signal,
            }),
          config: resolveCodexComputerUseConfig({
            pluginConfig: {
              computerUse: {
                enabled: true,
                marketplaceName: "desktop-tools",
                autoRepair: true,
                strictReadiness: true,
              },
            },
          }),
          signal: controller.signal,
        });
        const rejected = expect(readiness).rejects.toThrow(
          cancelled ? "aborted" : "Computer Use readiness cleanup failed",
        );
        if (cancelled) {
          await waitForHarnessRequest(harness, "mcpServer/tool/call");
          controller.abort();
        }
        await rejected;
        expect(harness.stdinDestroyed).toBe(true);
        expect(requestCalls(fixture).filter(([method]) => method === "thread/start")).toHaveLength(
          1,
        );
      } finally {
        await harness.client.closeAndWait();
      }
    },
  );

  it("holds one client lease through a one-off readiness probe and its cleanup", async () => {
    const fixture = createComputerUseRequest({ installed: true });
    const harness = createClientHarness({
      onWrite(line, send) {
        const frame = JSON.parse(line) as { id: number; method: string; params?: unknown };
        void fixture(frame.method, frame.params).then(
          (result) => send({ id: frame.id, result: result ?? null }),
          (error: unknown) =>
            send({ id: frame.id, error: { code: -32000, message: String(error) } }),
        );
      },
    });
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValue(harness.client);
    try {
      await expect(
        readCodexComputerUseStatus({
          pluginConfig: { computerUse: { enabled: true, marketplaceName: "desktop-tools" } },
        }),
      ).resolves.toMatchObject({ ready: true });
      expect(sharedClientMocks.getLeasedSharedCodexAppServerClient).toHaveBeenCalledTimes(1);
      expect(
        sharedClientMocks.releaseLeasedSharedCodexAppServerClient,
      ).toHaveBeenCalledExactlyOnceWith(harness.client);
      expect(fixture).toHaveBeenCalledWith("thread/unsubscribe", {
        threadId: "computer-use-probe-thread-1",
      });
    } finally {
      await harness.client.closeAndWait();
    }
  });

  it("reports an installed Computer Use MCP server from a registered marketplace", async () => {
    const request = createComputerUseRequest({ installed: true });

    const status = await readCodexComputerUseStatus({
      pluginConfig: { computerUse: { enabled: true, marketplaceName: "desktop-tools" } },
      request,
    });

    expectStatusFields(status, {
      enabled: true,
      ready: true,
      reason: "ready",
      installed: true,
      pluginEnabled: true,
      mcpServerAvailable: true,
      marketplaceName: "desktop-tools",
      tools: ["list_apps"],
      message: "Computer Use is ready.",
    });
    expect(status.installation).toMatchObject({
      status: "installed",
      ok: true,
    });
    expect(status.exposure).toMatchObject({
      status: "available",
      ok: true,
    });
    expect(status.liveTest).toMatchObject({
      status: "passed",
      ok: true,
      attempted: true,
      attempts: 1,
      timeoutMs: 60_000,
      retried: false,
      repaired: false,
    });
    expect(request).toHaveBeenCalledWith(
      "thread/start",
      {
        input: [],
        developerInstructions: "OpenClaw Computer Use readiness probe",
        ephemeral: true,
      },
      { timeoutMs: 60_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "mcpServer/tool/call",
      {
        threadId: "computer-use-probe-thread-1",
        server: "computer-use",
        tool: "list_apps",
        arguments: {},
      },
      {
        timeoutMs: 60_000,
      },
    );
    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "computer-use-probe-thread-1" },
      { timeoutMs: 60_000, signal: expect.any(AbortSignal) },
    );
    expectRequestMethodNotCalled(request, "thread/archive");
    expectRequestMethodNotCalled(request, "marketplace/add");
    expectRequestMethodNotCalled(request, "experimentalFeature/enablement/set");
    expectRequestMethodNotCalled(request, "plugin/install");
  });

  it("probes unified Computer Use through its JavaScript tool", async () => {
    const request = createComputerUseRequest({
      installed: true,
      pluginName: "unified-computer-use",
      mcpServerName: "cua_repl",
      mcpTools: ["js", "js_reset", "turn_ended"],
    });

    const status = await readCodexComputerUseStatus({
      pluginConfig: {
        computerUse: {
          enabled: true,
          marketplaceName: "desktop-tools",
          pluginName: "unified-computer-use",
          mcpServerName: "cua_repl",
        },
      },
      request,
    });

    expect(request).toHaveBeenCalledWith(
      "mcpServer/tool/call",
      {
        threadId: "computer-use-probe-thread-1",
        server: "cua_repl",
        tool: "js",
        arguments: { code: "await cua.getState();" },
      },
      { timeoutMs: 60_000 },
    );
    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      pluginName: "unified-computer-use",
      mcpServerName: "cua_repl",
      tools: ["js", "js_reset", "turn_ended"],
    });
  });

  it("inherits managed security policy when starting a Computer Use readiness probe", async () => {
    const request = createComputerUseRequest({ installed: true });
    const managedRequest = vi.fn(async (method: string, params?: unknown) => {
      if (method === "thread/start") {
        const threadParams = requireRecord(params, "managed readiness thread");
        if ("sandbox" in threadParams || "approvalPolicy" in threadParams) {
          throw new Error("enterprise policy does not permit thread security overrides");
        }
      }
      return await request(method, params);
    }) as CodexComputerUseRequest;

    const status = await readCodexComputerUseStatus({
      pluginConfig: {
        computerUse: {
          enabled: true,
          marketplaceName: "desktop-tools",
          strictReadiness: true,
        },
      },
      request: managedRequest,
    });

    expect(status).toMatchObject({ ready: true, reason: "ready" });
  });

  it("treats MCP error results as failed readiness probes", async () => {
    const request = createComputerUseRequest({ installed: true, liveTestResultErrors: 2 });

    const status = await readCodexComputerUseStatus({
      pluginConfig: { computerUse: { enabled: true, marketplaceName: "desktop-tools" } },
      request,
    });

    expect(status).toMatchObject({ ready: false, reason: "live_test_failed" });
    expect(status.liveTest).toMatchObject({
      status: "failed",
      ok: false,
      attempts: 2,
      error: "Computer Use readiness tool computer-use.list_apps returned an error result",
    });
  });

  it("repairs a failed probe through the owning MCP runtime without signaling sibling processes", async () => {
    const request = createComputerUseRequest({ installed: true, liveTestFailures: 1 });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const status = await readCodexComputerUseStatus({
        pluginConfig: {
          computerUse: { enabled: true, marketplaceName: "desktop-tools", autoRepair: true },
        },
        request,
      });

      expect(status).toMatchObject({ ready: true, reason: "ready" });
      expect(status.liveTest).toMatchObject({
        status: "passed",
        attempts: 2,
        retried: true,
        repaired: true,
      });
      expect(status.repair).toMatchObject({ attempted: true, killedPids: [], warnings: [] });
      expect(request).toHaveBeenCalledWith("config/mcpServer/reload", undefined, {
        timeoutMs: 60_000,
      });
      const methods = requestCalls(request).map(([method]) => method);
      expect(methods.indexOf("thread/unsubscribe")).toBeLessThan(
        methods.indexOf("config/mcpServer/reload"),
      );
      expect(
        requestCalls(request).filter(([method]) => method === "mcpServer/tool/call"),
      ).toHaveLength(2);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("reports an owner-managed MCP reload failure without preventing the bounded retry", async () => {
    const request = createComputerUseRequest({
      installed: true,
      liveTestFailures: 1,
      reloadFailures: 1,
    });

    const status = await readCodexComputerUseStatus({
      pluginConfig: {
        computerUse: { enabled: true, marketplaceName: "desktop-tools", autoRepair: true },
      },
      request,
    });

    expect(status.liveTest).toMatchObject({ status: "passed", attempts: 2, repaired: false });
    expect(status.repair).toMatchObject({
      attempted: true,
      killedPids: [],
      warnings: ["Could not reload Computer Use MCP servers: MCP runtime reload failed"],
    });
    expect(status.warnings).toContain(
      "Could not reload Computer Use MCP servers: MCP runtime reload failed",
    );
  });

  it.each([false, true])(
    "propagates a desktop selection change without retrying the stale client (cleanup fails: %s)",
    async (cleanupFails) => {
      const selectionChanged = Object.assign(new Error("desktop selection changed"), {
        code: "CODEX_APP_SERVER_START_SELECTION_CHANGED",
      });
      const harness = createClientHarness();
      const request = vi.fn(async (method: string) => {
        if (method === "thread/start") {
          return { thread: { id: "probe-thread" } };
        }
        if (method === "mcpServer/tool/call") {
          throw selectionChanged;
        }
        if (method === "thread/unsubscribe") {
          if (cleanupFails) {
            throw new Error("unsubscribe failed");
          }
          return undefined;
        }
        throw new Error(`unexpected request: ${method}`);
      }) as CodexComputerUseRequest;

      try {
        const failure = await runCodexComputerUseLiveTest({
          request,
          client: harness.client,
          config: resolveCodexComputerUseConfig({
            pluginConfig: { computerUse: { enabled: true, autoRepair: true } },
          }),
        }).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(harness.stdinDestroyed).toBe(cleanupFails);
        expect(failure).toBe(selectionChanged);
        expect(requestCalls(request).map(([method]) => method)).toEqual([
          "thread/start",
          "mcpServer/tool/call",
          "thread/unsubscribe",
        ]);
      } finally {
        await harness.client.closeAndWait();
      }
    },
  );

  it.each([false, true])(
    "fails fast when MCP exposes no tools (strict: %s)",
    async (strictReadiness) => {
      const request = createComputerUseRequest({ installed: true, mcpToolsAvailable: false });

      await expectSetupErrorStatus(
        installCodexComputerUse({
          pluginConfig: {
            computerUse: {
              enabled: true,
              strictReadiness,
              marketplaceName: "desktop-tools",
            },
          },
          request,
        }),
        {
          ready: false,
          reason: "mcp_missing",
          mcpServerAvailable: false,
          tools: [],
          message: "Computer Use is installed, but the computer-use MCP server exposes no tools.",
        },
      );
      expectRequestMethodNotCalled(request, "thread/start");
      expectRequestMethodNotCalled(request, "mcpServer/tool/call");
    },
  );

  it("reloads empty MCP exposure once during install before failing closed", async () => {
    const request = createComputerUseRequest({ installed: true, mcpToolsAvailable: false });

    await expectSetupErrorStatus(
      installCodexComputerUse({
        pluginConfig: { computerUse: { marketplaceName: "desktop-tools" } },
        request,
      }),
      { ready: false, reason: "mcp_missing", mcpServerAvailable: false },
    );
    expect(
      requestCalls(request).filter(([method]) => method === "config/mcpServer/reload"),
    ).toHaveLength(1);
    expectRequestMethodNotCalled(request, "thread/start");
  });

  it("does not reload the Computer Use MCP runtime unless autoRepair is enabled", async () => {
    const request = createComputerUseRequest({ installed: true, liveTestFailures: 2 });

    const status = await readCodexComputerUseStatus({
      pluginConfig: { computerUse: { enabled: true, marketplaceName: "desktop-tools" } },
      request,
    });

    expect(status.liveTest).toMatchObject({
      status: "failed",
      ok: false,
      attempts: 2,
      retried: true,
      repaired: false,
    });
    expectStatusFields(status, {
      ready: false,
      reason: "live_test_failed",
      installed: true,
      pluginEnabled: true,
      mcpServerAvailable: true,
    });
    expect(status.warnings).toContain(
      "Computer Use live test failed, but ordinary Codex turns remain available until a Computer Use tool is invoked.",
    );
    expect(status.message).toContain(
      "Ordinary Codex turns remain available; Computer Use will report this failure if invoked.",
    );
    expect(status.repair).toBeUndefined();
    expectRequestMethodNotCalled(request, "config/mcpServer/reload");
  });

  it("surfaces install, exposure, and live-test layers separately when the live test fails", async () => {
    const request = createComputerUseRequest({ installed: true, liveTestFailures: 2 });

    const status = await readCodexComputerUseStatus({
      pluginConfig: {
        computerUse: {
          enabled: true,
          marketplaceName: "desktop-tools",
          autoRepair: true,
          strictReadiness: true,
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: false,
      reason: "live_test_failed",
      installed: true,
      pluginEnabled: true,
      mcpServerAvailable: true,
    });
    expect(status.installation).toMatchObject({ status: "installed", ok: true });
    expect(status.exposure).toMatchObject({ status: "available", ok: true });
    expect(status.liveTest).toMatchObject({
      status: "failed",
      ok: false,
      attempted: true,
      attempts: 2,
      timeoutMs: 60_000,
      retried: true,
      repaired: true,
      error: "list_apps timed out",
    });
    expect(status.message).toContain("Computer Use live test failed after 2 attempts");
    expect(
      requestCalls(request).filter(([method]) => method === "config/mcpServer/reload"),
    ).toHaveLength(1);
  });
});
