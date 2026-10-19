import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureCodexComputerUse,
  installCodexComputerUse,
  readCodexComputerUseStatus,
} from "./computer-use.js";
import {
  createComputerUseRequest,
  expectRequestMethodNotCalled,
  expectSetupErrorStatus,
  expectStatusFields,
  requestCalls,
} from "./computer-use.test-support.js";
import type { CodexComputerUseConfig } from "./config.js";
import { createClientHarness, waitForHarnessRequest } from "./test-support.js";

const exposed = { installed: true, pluginEnabled: true, mcpServerAvailable: true };

const sharedClientMocks = vi.hoisted(() => ({
  getLeasedSharedCodexAppServerClient: vi.fn(),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
}));

vi.mock("./shared-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared-client.js")>()),
  ...sharedClientMocks,
}));

function readinessConfig(computerUse: CodexComputerUseConfig = {}) {
  return { computerUse: { enabled: true, marketplaceName: "desktop-tools", ...computerUse } };
}

describe("Codex Computer Use readiness", () => {
  afterEach(() => {
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockReset();
    sharedClientMocks.releaseLeasedSharedCodexAppServerClient.mockReset();
  });

  it.each([
    { cancelled: true, cleanupFails: false },
    { cancelled: false, cleanupFails: true },
    { cancelled: true, cleanupFails: true },
  ])(
    "cleans up cancelled=$cancelled probes with failed unsubscribe=$cleanupFails",
    async ({ cancelled, cleanupFails }) => {
      const fixture = createComputerUseRequest({ installed: true });
      const controller = new AbortController();
      let subscribed = false;
      const harness = createProbeHarness(fixture, {
        hold: ["turn/start", ...(cancelled ? ["mcpServer/tool/call"] : [])],
        unsubscribeError: cleanupFails,
        onReply(method) {
          if (method === "thread/start") {
            subscribed = true;
          } else if (method === "thread/unsubscribe") {
            subscribed = false;
          }
        },
      });
      const peer = cleanupFails
        ? undefined
        : harness.client.request("turn/start", { threadId: "healthy-peer" });
      void peer?.catch(() => undefined);
      try {
        const peerStart = peer && (await waitForHarnessRequest(harness, "turn/start"));
        const readiness = ensureCodexComputerUse({
          client: harness.client,
          pluginConfig: readinessConfig({
            autoRepair: cleanupFails,
            strictReadiness: true,
            ...(!cleanupFails ? { liveTestTimeoutMs: 1_000 } : {}),
          }),
          signal: controller.signal,
        });
        const rejected = expect(readiness).rejects.toThrow(
          cancelled ? "aborted" : "Computer Use readiness cleanup failed",
        );
        if (cancelled) {
          await waitForHarnessRequest(harness, "mcpServer/tool/call");
          expect(subscribed).toBe(true);
          controller.abort();
        }
        await rejected;
        expect(harness.stdinDestroyed).toBe(cleanupFails);
        expect(requestCalls(fixture, "thread/start")).toHaveLength(1);
        if (!cleanupFails) {
          expect(subscribed).toBe(false);
          assert(peerStart && peer);
          harness.send({ id: peerStart.id, result: { turn: { id: "healthy-turn" } } });
          await expect(peer).resolves.toEqual({ turn: { id: "healthy-turn" } });
        }
      } finally {
        await harness.client.closeAndWait();
      }
    },
  );

  it("holds one client lease through a one-off readiness probe and its cleanup", async () => {
    const fixture = createComputerUseRequest({ installed: true });
    const harness = createProbeHarness(fixture);
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValue(harness.client);
    try {
      const status = await readCodexComputerUseStatus({ pluginConfig: readinessConfig() });
      expect(status).toMatchObject({
        enabled: true,
        ready: true,
        reason: "ready",
        ...exposed,
        marketplaceName: "desktop-tools",
        tools: ["list_apps"],
        message: "Computer Use is ready.",
        installation: { status: "installed", ok: true },
        exposure: { status: "available", ok: true },
        liveTest: {
          status: "passed",
          ok: true,
          attempted: true,
          attempts: 1,
          timeoutMs: 60_000,
          retried: false,
          repaired: false,
        },
      });
      expect(requestCalls(fixture).map(([method]) => method)).toEqual(
        expect.arrayContaining(["thread/start", "mcpServer/tool/call", "thread/unsubscribe"]),
      );
      expectRequestMethodNotCalled(
        fixture,
        "thread/archive",
        "marketplace/add",
        "experimentalFeature/enablement/set",
        "plugin/install",
      );
      expect(sharedClientMocks.getLeasedSharedCodexAppServerClient).toHaveBeenCalledTimes(1);
      expect(
        sharedClientMocks.releaseLeasedSharedCodexAppServerClient,
      ).toHaveBeenCalledExactlyOnceWith(harness.client);
    } finally {
      await harness.client.closeAndWait();
    }
  });

  it("probes unified Computer Use through its JavaScript tool", async () => {
    const unified = { pluginName: "unified-computer-use", mcpServerName: "cua_repl" };
    const { request, status } = await readProbe(
      { ...unified, mcpTools: ["js", "js_reset", "turn_ended"] },
      unified,
    );

    expect(requestCalls(request, "mcpServer/tool/call")).toHaveLength(1);
    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      ...unified,
      tools: ["js", "js_reset", "turn_ended"],
    });
  });

  it.each([0, 1])(
    "retries through the owning runtime with %i reload failures",
    async (reloadFailures) => {
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      try {
        const { request, status } = await readProbe(
          { liveTestFailures: 1, reloadFailures },
          { autoRepair: true },
        );
        const warning = "Could not reload Computer Use MCP servers: MCP runtime reload failed";
        expect(status).toMatchObject({
          ready: true,
          reason: "ready",
          liveTest: { status: "passed", attempts: 2, retried: true, repaired: !reloadFailures },
          repair: { attempted: true, killedPids: [], warnings: reloadFailures ? [warning] : [] },
        });
        if (reloadFailures) {
          expect(status.warnings).toContain(warning);
        }
        expect(request).toHaveBeenCalledWith("config/mcpServer/reload", undefined, {
          timeoutMs: 60_000,
        });
        const methods = requestCalls(request).map(([method]) => method);
        expect(methods.indexOf("thread/unsubscribe")).toBeLessThan(
          methods.indexOf("config/mcpServer/reload"),
        );
        expect(requestCalls(request, "mcpServer/tool/call")).toHaveLength(2);
        expect(killSpy).not.toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
      }
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
    expect(requestCalls(request, "config/mcpServer/reload")).toHaveLength(1);
    expectRequestMethodNotCalled(request, "thread/start");
  });

  it.each([
    { liveTestFailures: 2, error: "list_apps timed out" },
    {
      liveTestResultErrors: 2,
      error: "Computer Use readiness tool computer-use.list_apps returned an error result",
    },
  ])("reports a failed probe without implicit repair: $error", async ({ error, ...failures }) => {
    const { request, status } = await readProbe(failures);
    expect(status).toMatchObject({
      ...exposed,
      ready: false,
      reason: "live_test_failed",
      liveTest: { status: "failed", ok: false, attempts: 2, retried: true, repaired: false, error },
    });
    expect(status.warnings).toContain(
      "Computer Use live test failed, but compatibility startup remains enabled; set computerUse.strictReadiness to true to block startup after a failed live test.",
    );
    expect(status.message).toContain(
      "Startup is allowed because computerUse.strictReadiness is false.",
    );
    expect(status.repair).toBeUndefined();
    expectRequestMethodNotCalled(request, "config/mcpServer/reload");
  });

  it("fails startup closed when strictReadiness is enabled", async () => {
    const request = createComputerUseRequest({ installed: true, liveTestFailures: 2 });

    await expect(
      ensureCodexComputerUse({
        pluginConfig: readinessConfig({ strictReadiness: true, autoRepair: true }),
        request,
      }),
    ).rejects.toMatchObject({
      status: {
        ready: false,
        reason: "live_test_failed",
        ...exposed,
        installation: { status: "installed", ok: true },
        exposure: { status: "available", ok: true },
        liveTest: {
          status: "failed",
          ok: false,
          attempted: true,
          attempts: 2,
          timeoutMs: 60_000,
          retried: true,
          repaired: true,
          error: "list_apps timed out",
        },
        message: expect.stringContaining("Computer Use live test failed after 2 attempts"),
      },
    });
    expect(requestCalls(request, "config/mcpServer/reload")).toHaveLength(1);
  });
});

function createProbeHarness(
  fixture: ReturnType<typeof createComputerUseRequest>,
  options: { hold?: string[]; unsubscribeError?: boolean; onReply?: (method: string) => void } = {},
) {
  return createClientHarness({
    onWrite(line, send) {
      const frame = JSON.parse(line) as { id: number; method: string; params?: unknown };
      if (options.hold?.includes(frame.method)) {
        return;
      }
      if (frame.method === "thread/unsubscribe" && options.unsubscribeError) {
        send({ id: frame.id, error: { code: -32000, message: "unsubscribe failed" } });
        return;
      }
      void fixture(frame.method, frame.params).then(
        (result) => {
          options.onReply?.(frame.method);
          send({ id: frame.id, result: result ?? null });
        },
        (error: unknown) => send({ id: frame.id, error: { code: -32000, message: String(error) } }),
      );
    },
  });
}

async function readProbe(
  options: Omit<Parameters<typeof createComputerUseRequest>[0], "installed">,
  config: CodexComputerUseConfig = {},
) {
  const request = createComputerUseRequest({ installed: true, ...options });
  const status = await readCodexComputerUseStatus({
    request,
    pluginConfig: readinessConfig(config),
  });
  return { request, status };
}
