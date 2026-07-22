// QA Lab Matrix tests cover scenario environment readiness boundaries.
import { afterEach, describe, expect, it, vi } from "vitest";

const buildMatrixQaConfig = vi.hoisted(() =>
  vi.fn((_baseConfig: unknown, params: { sutAccountId: string }) => ({
    channels: {
      matrix: {
        accounts: {
          [params.sutAccountId]: {
            dm: { allowFrom: ["@driver:test"] },
            groupAllowFrom: ["@driver:test"],
            groups: {
              "!room:matrix-qa.test": { tools: { allow: ["sessions_spawn"] } },
            },
          },
        },
      },
    },
  })),
);

vi.mock("../substrate/config.js", () => ({ buildMatrixQaConfig }));
vi.mock("./scenario-runtime-room.js", () => ({ runMatrixQaCanary: vi.fn() }));

import { createMatrixQaScenarioEnvironment } from "./scenario-environment.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("matrix scenario environment", () => {
  it("waits for config restart settle before accepting Matrix readiness", async () => {
    vi.useFakeTimers();
    const callOrder: string[] = [];
    let configReadCount = 0;
    let statusReadCount = 0;
    const gateway = {
      baseUrl: "http://127.0.0.1:12345",
      runtimeEnv: {},
      tempRoot: "/tmp/matrix-qa",
      workspaceDir: "/tmp/matrix-qa/workspace",
      call: vi.fn(async (method: string, _params?: unknown, _options?: unknown) => {
        callOrder.push(method);
        if (method === "config.get") {
          configReadCount += 1;
          if (configReadCount === 1) {
            return { config: {} };
          }
          if (configReadCount === 2) {
            return { hash: "config-hash" };
          }
          return {
            appliedConfigHash: configReadCount === 3 ? "old-revision" : "new-revision",
            configRevisionHash: "new-revision",
            hash: "patched-config-hash",
          };
        }
        if (method === "config.patch") {
          return {
            hash: "patched-config-hash",
            ok: true,
            sentinel: { payload: { stats: { requiresRestart: true } } },
          };
        }
        if (method === "channels.status") {
          statusReadCount += 1;
          return {
            channelAccounts: {
              matrix: [
                {
                  accountId: "work",
                  connected: true,
                  healthState: "healthy",
                  lastStartAt: statusReadCount < 3 ? 100 : 200,
                  restartPending: false,
                  running: true,
                },
              ],
            },
          };
        }
        if (method === "exec.approval.request") {
          return { id: "approval-1", status: "accepted" };
        }
        throw new Error(`unexpected gateway method ${method}`);
      }),
    };
    const environment = createMatrixQaScenarioEnvironment({
      accountId: "work",
      harness: { baseUrl: "http://127.0.0.1:8008", recording: {} } as never,
      observedEvents: [],
      provisioning: {
        driver: { accessToken: "fixture", userId: "@driver:test" },
        observer: { accessToken: "fixture", userId: "@observer:test" },
        roomId: "!room:test",
        sut: { accessToken: "fixture", userId: "@sut:test" },
        topology: { rooms: [] },
      } as never,
    });
    const waitForConfigRestartSettle = vi.fn(async () => {
      callOrder.push("config.settle");
    });

    const preparing = environment.prepareFlow({
      config: {
        matrixConfigOverrides: {
          agentDefaults: { model: { fallbacks: ["fixture/fallback"] } },
          audio: { models: [{ model: "transcribe", provider: "fixture" }] },
          groupMentionPatterns: ["matrix qa"],
        },
      },
      gateway,
      outputDir: "/tmp/matrix-qa/output",
      timeoutMs: 1_000,
      waitForConfigRestartSettle,
    });
    await vi.runAllTimersAsync();
    const prepared = await preparing;
    const scenarioContext = prepared.scenarioContext;
    await scenarioContext.gatewayCall?.(
      "exec.approval.request",
      { id: "approval-1" },
      { expectFinal: false, timeoutMs: 1_000 },
    );

    expect(statusReadCount).toBe(3);
    expect(callOrder).toEqual([
      "config.get",
      "channels.status",
      "config.get",
      "config.patch",
      "config.settle",
      "config.get",
      "config.get",
      "channels.status",
      "channels.status",
      "exec.approval.request",
    ]);
    expect(waitForConfigRestartSettle).toHaveBeenCalledWith({
      restartDelayMs: 0,
      timeoutMs: 1_000,
    });
    expect(gateway.call).toHaveBeenCalledWith(
      "config.patch",
      expect.objectContaining({
        replacePaths: [
          "agents.defaults.model.fallbacks",
          "channels.matrix.accounts.work.dm.allowFrom",
          "channels.matrix.accounts.work.groupAllowFrom",
          "channels.matrix.accounts.work.groups.!room:matrix-qa.test.tools.allow",
          "messages.groupChat.mentionPatterns",
          "tools.media.audio.models",
        ],
      }),
      { timeoutMs: 60_000 },
    );
    expect(gateway.call).toHaveBeenLastCalledWith(
      "exec.approval.request",
      { id: "approval-1" },
      { expectFinal: false, timeoutMs: 1_000 },
    );
    const patchCall = gateway.call.mock.calls.find(([method]) => method === "config.patch");
    if (!patchCall) {
      throw new Error("expected config.patch gateway call");
    }
    expect((patchCall[1] as { replacePaths?: string[] }).replacePaths).not.toContain(
      "channels.matrix.accounts.sut.groupAllowFrom",
    );
  });

  it("waits for a pending config revision after a no-op patch", async () => {
    vi.useFakeTimers();
    const callOrder: string[] = [];
    let configReadCount = 0;
    const gateway = {
      baseUrl: "http://127.0.0.1:12345",
      runtimeEnv: {},
      tempRoot: "/tmp/matrix-qa",
      workspaceDir: "/tmp/matrix-qa/workspace",
      call: vi.fn(async (method: string) => {
        callOrder.push(method);
        if (method === "config.get") {
          configReadCount += 1;
          if (configReadCount === 1) {
            return { config: {} };
          }
          if (configReadCount === 2) {
            return { hash: "config-hash" };
          }
          return {
            appliedConfigHash: configReadCount === 3 ? "old-revision" : "new-revision",
            configRevisionHash: "new-revision",
            hash: "config-hash",
          };
        }
        if (method === "config.patch") {
          return {
            noop: true,
            ok: true,
          };
        }
        if (method === "channels.status") {
          return {
            channelAccounts: {
              matrix: [
                {
                  accountId: "sut",
                  connected: true,
                  healthState: "healthy",
                  lastStartAt: 100,
                  restartPending: false,
                  running: true,
                },
              ],
            },
          };
        }
        throw new Error(`unexpected gateway method ${method}`);
      }),
    };
    const environment = createMatrixQaScenarioEnvironment({
      accountId: "sut",
      harness: { baseUrl: "http://127.0.0.1:8008", recording: {} } as never,
      observedEvents: [],
      provisioning: {
        driver: { accessToken: "fixture", userId: "@driver:test" },
        observer: { accessToken: "fixture", userId: "@observer:test" },
        roomId: "!room:test",
        sut: { accessToken: "fixture", userId: "@sut:test" },
        topology: { rooms: [] },
      } as never,
    });
    const waitForConfigRestartSettle = vi.fn(async () => {
      callOrder.push("config.settle");
    });

    const preparing = environment.prepareFlow({
      config: {},
      gateway,
      outputDir: "/tmp/matrix-qa/output",
      timeoutMs: 1_000,
      waitForConfigRestartSettle,
    });
    await vi.runAllTimersAsync();
    await preparing;

    expect(callOrder).toEqual([
      "config.get",
      "channels.status",
      "config.get",
      "config.patch",
      "config.get",
      "config.get",
      "channels.status",
    ]);
    expect(waitForConfigRestartSettle).not.toHaveBeenCalled();
  });
});
