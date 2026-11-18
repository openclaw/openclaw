import { afterEach, describe, expect, it, vi } from "vitest";

const buildMatrixQaConfig = vi.hoisted(() =>
  vi.fn(() => ({ channels: { matrix: { execApprovals: { enabled: true } } } })),
);
vi.mock("../substrate/config.js", () => ({ buildMatrixQaConfig }));
// mock-isolation: Keep canary room traffic synthetic while exercising environment preparation.
vi.mock("./scenario-runtime-room.js", () => ({ runMatrixQaCanary: vi.fn() }));

import { createMatrixQaScenarioEnvironment } from "./scenario-environment.js";

afterEach(() => vi.useRealTimers());

function createEnvironment() {
  return createMatrixQaScenarioEnvironment({
    accountId: "sut",
    harness: { baseUrl: "http://127.0.0.1:8008", recording: {} } as never,
    observedEvents: [],
    provisioning: {
      observationAccounts: {
        driver: { accessToken: "driver-room-observation" },
        observer: { accessToken: "observer-room-observation" },
      },
      driver: { accessToken: "fixture", userId: "@driver:test" },
      observer: { accessToken: "fixture", userId: "@observer:test" },
      roomId: "!room:test",
      sut: { accessToken: "fixture", userId: "@sut:test" },
      topology: { rooms: [] },
    } as never,
  });
}

const gatewayPaths = {
  baseUrl: "http://127.0.0.1:12345",
  runtimeEnv: {},
  tempRoot: "/tmp/matrix-qa",
  workspaceDir: "/tmp/matrix-qa/workspace",
};

type Preparation = Parameters<ReturnType<typeof createEnvironment>["prepareFlow"]>[0];
const prepareInput = (gateway: Preparation["gateway"], overrides: Partial<Preparation> = {}) => ({
  config: {},
  gateway,
  outputDir: "/tmp/matrix-qa/output",
  scenarioId: "matrix-test",
  scenarioTitle: "Matrix test",
  timeoutMs: 8_000,
  waitForConfigRestartSettle: vi.fn(),
  ...overrides,
});
const appliedConfig = (hash = "patched-config-hash") => ({
  appliedConfigHash: hash,
  configRevisionHash: hash,
  hash,
});
const matrixAccounts = (accounts: Record<string, unknown>, enabled?: boolean) => ({
  channels: { matrix: { accounts, ...(enabled === undefined ? {} : { enabled }) } },
});
type CallOptions = { deadlineMs?: number; expectFinal?: boolean; timeoutMs?: number };
function gatewayFor(
  handlers: Record<string, (params?: unknown, opts?: CallOptions) => unknown>,
  onCall?: (method: string, opts?: CallOptions) => void,
) {
  return {
    ...gatewayPaths,
    call: vi.fn(async (method: string, params?: unknown, opts?: CallOptions) => {
      onCall?.(method, opts);
      const handler = handlers[method];
      if (!handler) {
        throw new Error(`unexpected gateway method ${method}`);
      }
      return handler(params, opts);
    }),
  };
}
function configReads(applied: (params?: unknown, opts?: CallOptions) => unknown) {
  return vi
    .fn()
    .mockReturnValueOnce({ config: {} })
    .mockReturnValueOnce({ hash: "config-hash" })
    .mockImplementation(applied);
}

function healthyMatrixStatus(lastStartAt: number) {
  return {
    channelAccounts: {
      matrix: [
        {
          accountId: "sut",
          connected: true,
          healthState: "healthy",
          lastStartAt,
          restartPending: false,
          running: true,
        },
      ],
    },
  };
}

describe("matrix scenario environment", () => {
  it("restores ordered override-heavy config to defaults from fresh current config", async () => {
    buildMatrixQaConfig.mockClear();
    const execApprovalOverrides = {
      agentFilter: ["main", "stale"],
      approvers: ["@driver:test", "@stale:test"],
      sessionFilter: ["matrix", "stale"],
    };
    const audioOverrides = {
      scope: {
        default: "deny" as const,
        rules: [{ action: "deny" as const }],
      },
    };
    const baselineConfig = matrixAccounts({ sut: { enabled: true } }, false);
    const firstTarget = {
      ...matrixAccounts({ sut: { enabled: true, execApprovals: execApprovalOverrides } }, true),
      tools: { media: { audio: audioOverrides } },
    };
    const preservedPlugin = {
      config: { preserve: "matrix-config" },
      hooks: { allowConversationAccess: true },
      llm: { allowModelOverride: true },
      subagent: { allowModelOverride: true },
    };
    const snapshot = (stale: boolean) => {
      const keep = <T>(values: T[]) => (stale ? values : values.slice(0, 1));
      const allowlist = keep(["@driver:test", "@stale:test"]);
      return {
        ...matrixAccounts({
          sut: {
            ...(stale ? { autoJoin: "allowlist", execApprovals: execApprovalOverrides } : {}),
            autoJoinAllowlist: allowlist,
            dm: { allowFrom: allowlist, ...(stale ? { sessionScope: "per-user" } : {}) },
            groupAllowFrom: allowlist,
            groups: {
              "!room:test": {
                tools: { allow: keep(["read", "write"]), deny: keep(["shell", "network"]) },
              },
            },
          },
          ...(stale ? { "qa-driver-bot-source": { enabled: true } } : {}),
        }),
        messages: { groupChat: { mentionPatterns: keep(["@sut", "@sut"]) } },
        plugins: { entries: { matrix: { ...preservedPlugin, enabled: !stale } } },
        tools: {
          media: {
            audio: {
              scope: {
                ...(stale ? { default: "deny" } : {}),
                rules: keep([{ action: "allow" }, { action: "deny" }]),
              },
            },
            models: keep([{ provider: "first" }, { provider: "stale" }]),
          },
        },
      };
    };
    const currentConfig = snapshot(true);
    const secondTarget = snapshot(false);
    buildMatrixQaConfig
      .mockReturnValueOnce(firstTarget as never)
      .mockReturnValueOnce(secondTarget as never);
    let patchCount = 0;
    let statusCount = 0;
    const gateway = gatewayFor({
      "config.get": vi
        .fn()
        .mockReturnValueOnce({ config: baselineConfig })
        .mockReturnValueOnce({ hash: "base-1" })
        .mockReturnValueOnce(appliedConfig("patched-1"))
        .mockReturnValueOnce({ config: currentConfig })
        .mockReturnValueOnce({ hash: "base-2" })
        .mockReturnValueOnce(appliedConfig("patched-2")),
      "config.patch": () => {
        patchCount += 1;
        return { hash: `patched-${patchCount}`, changedPaths: ["channels.matrix"], ok: true };
      },
      "channels.status": () => {
        statusCount += 1;
        return healthyMatrixStatus(statusCount);
      },
    });
    const environment = createEnvironment();
    const input: Preparation = prepareInput(gateway, {
      config: {
        matrixConfigOverrides: {
          audio: audioOverrides,
          execApprovals: execApprovalOverrides,
        },
      } as Record<string, unknown>,
    });

    await environment.prepareFlow(input);
    input.config = {};
    await environment.prepareFlow(input);

    expect(buildMatrixQaConfig.mock.calls).toMatchObject([
      [
        baselineConfig,
        {
          currentConfig: baselineConfig,
          overrides: {
            audio: audioOverrides,
            execApprovals: execApprovalOverrides,
          },
        },
      ],
      [baselineConfig, { currentConfig, overrides: undefined }],
    ]);
    const patchCalls = gateway.call.mock.calls.filter(([method]) => method === "config.patch");
    expect(patchCalls).toHaveLength(2);
    const secondPatchParams = patchCalls[1]?.[1] as {
      raw: string;
      replacePaths?: string[];
    };
    const secondPatch = JSON.parse(secondPatchParams.raw) as Record<string, unknown>;
    expect(secondPatch).toHaveProperty("channels.matrix.accounts.sut.autoJoin", null);
    expect(secondPatch).toHaveProperty("channels.matrix.accounts.sut.dm.sessionScope", null);
    expect(secondPatch).toHaveProperty("channels.matrix.accounts.sut.execApprovals", null);
    expect(secondPatch).toHaveProperty("channels.matrix.accounts.qa-driver-bot-source", null);
    expect(secondPatch).toHaveProperty("tools.media.audio.scope.default", null);
    expect(secondPatch).toHaveProperty("plugins.entries.matrix", { enabled: true });
    expect(secondPatchParams.replacePaths).toEqual([
      "channels.matrix.accounts.sut.autoJoinAllowlist",
      "channels.matrix.accounts.sut.dm.allowFrom",
      "channels.matrix.accounts.sut.execApprovals.agentFilter",
      "channels.matrix.accounts.sut.execApprovals.approvers",
      "channels.matrix.accounts.sut.execApprovals.sessionFilter",
      "channels.matrix.accounts.sut.groupAllowFrom",
      "channels.matrix.accounts.sut.groups.!room:test.tools.allow",
      "channels.matrix.accounts.sut.groups.!room:test.tools.deny",
      "messages.groupChat.mentionPatterns",
      "tools.media.audio.scope.rules",
      "tools.media.models",
    ]);
  });

  it("shares the preparation deadline and forwards gateway action options", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let revisionReadCount = 0;
    let statusReadCount = 0;
    const revisionTimeouts: number[] = [];
    const statusTimeouts: number[] = [];
    const gateway = gatewayFor(
      {
        "config.get": configReads((_params, opts) => {
          revisionReadCount += 1;
          revisionTimeouts.push(opts?.timeoutMs ?? -1);
          if (revisionReadCount === 1) {
            vi.setSystemTime(56_000);
          }
          return {
            appliedConfigHash: revisionReadCount === 1 ? "old-revision" : "new-revision",
            configRevisionHash: "new-revision",
            hash: "patched-config-hash",
          };
        }),
        "config.patch": () => ({
          hash: "patched-config-hash",
          changedPaths: ["channels.matrix"],
          ok: true,
        }),
        "channels.status": (_params, opts) => {
          statusReadCount += 1;
          statusTimeouts.push(opts?.timeoutMs ?? -1);
          if (statusReadCount === 2) {
            vi.setSystemTime(56_500);
          }
          return healthyMatrixStatus(statusReadCount < 3 ? 100 : 200);
        },
        "exec.approval.request": () => ({ id: "approval-1", status: "accepted" }),
      },
      (_method, opts) => {
        if (opts?.deadlineMs !== undefined && opts.deadlineMs <= Date.now()) {
          throw new Error("gateway RPC deadline expired");
        }
      },
    );
    const environment = createEnvironment();
    const waitForConfigRestartSettle = vi.fn();

    const preparing = environment.prepareFlow(
      prepareInput(gateway, { waitForConfigRestartSettle }),
    );
    await vi.runAllTimersAsync();
    const prepared = await preparing;
    const scenarioContext = prepared.scenarioContext;
    await scenarioContext.gatewayCall?.(
      "exec.approval.request",
      { id: "approval-1" },
      { expectFinal: false, timeoutMs: 1_000 },
    );

    expect(revisionTimeouts).toEqual([5_000, 4_000]);
    expect(statusTimeouts).toEqual([5_000, 4_000, 3_500]);
    expect(Date.now()).toBe(56_500);
    expect(scenarioContext.timeoutMs).toBe(8_000);
    expect(waitForConfigRestartSettle).not.toHaveBeenCalled();
    const patchCall = gateway.call.mock.calls.find(([method]) => method === "config.patch");
    expect(patchCall?.[1]).not.toHaveProperty("replacePaths");
    expect(gateway.call).toHaveBeenLastCalledWith(
      "exec.approval.request",
      { id: "approval-1" },
      { expectFinal: false, timeoutMs: 1_000 },
    );
  });

  it("surfaces a stale config patch without a second effect", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let configReadCount = 0;
    const stale = new Error("config changed since last load");
    const gateway = gatewayFor({
      "config.get": () => {
        configReadCount += 1;
        if (configReadCount === 1) {
          return { config: {} };
        }
        return { hash: `base-${configReadCount}` };
      },
      "config.patch": () => {
        throw stale;
      },
      "channels.status": () => healthyMatrixStatus(100),
    });
    const environment = createEnvironment();

    await expect(environment.prepareFlow(prepareInput(gateway))).rejects.toBe(stale);

    expect(gateway.call.mock.calls.map(([method]) => method)).toEqual([
      "config.get",
      "channels.status",
      "config.get",
      "config.patch",
    ]);
  });

  it("requires a fresh account after an effective Matrix token change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let statusReadCount = 0;
    const statusTimeouts: number[] = [];
    const gateway = gatewayFor({
      "config.get": configReads(() => {
        vi.setSystemTime(59_900);
        return appliedConfig();
      }),
      "config.patch": () => ({
        hash: "patched-config-hash",
        changedPaths: ["channels.matrix.accounts.sut.accessToken"],
        noop: false,
        ok: true,
      }),
      "channels.status": (params, opts) => {
        statusReadCount += 1;
        statusTimeouts.push(opts?.timeoutMs ?? -1);
        if (statusReadCount === 2) {
          expect((params as { timeoutMs?: number } | undefined)?.timeoutMs).toBe(100);
          vi.setSystemTime(60_000);
        }
        if (statusReadCount === 3) {
          vi.setSystemTime(60_000);
        }
        return healthyMatrixStatus(100);
      },
    });
    const environment = createEnvironment();
    const waitForConfigRestartSettle = vi.fn();
    const preparing = environment.prepareFlow(
      prepareInput(gateway, { waitForConfigRestartSettle }),
    );
    const outcome = expect(preparing).rejects.toThrow('matrix account "sut" did not become ready');

    await vi.runAllTimersAsync();
    await outcome;

    expect(Date.now()).toBe(60_000);
    expect(statusTimeouts).toEqual([5_000, 100]);
    expect(
      gateway.call.mock.calls.map((call) => (call[2] as { deadlineMs?: number }).deadlineMs),
    ).toEqual(Array.from({ length: gateway.call.mock.calls.length }, () => 60_000));
    expect(waitForConfigRestartSettle).not.toHaveBeenCalled();
  });

  it("rejects a stale account start after a delayed failed pre-restart status read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let statusReadCount = 0;
    const mutateState = vi.fn(async () => undefined);
    const gateway = {
      ...gatewayFor({
        "config.get": configReads(() => appliedConfig("config-hash")),
        "config.patch": () => ({ hash: "config-hash", changedPaths: [], noop: true, ok: true }),
        "channels.status": () => {
          statusReadCount += 1;
          if (statusReadCount === 3) {
            vi.setSystemTime(1_500);
            throw new Error("status temporarily unavailable");
          }
          return healthyMatrixStatus(
            statusReadCount === 4 ? 1_200 : statusReadCount === 5 ? 1_500 : 1_600,
          );
        },
      }),
      restartAfterStateMutation: vi.fn<
        NonNullable<Preparation["gateway"]["restartAfterStateMutation"]>
      >(async (mutate) =>
        mutate({
          ...gatewayPaths,
          configPath: "/tmp/matrix-qa/config.json",
          stateDir: "/tmp/matrix-qa/state",
        }),
      ),
    };
    const environment = createEnvironment();
    const prepared = await environment.prepareFlow(prepareInput(gateway, { timeoutMs: 2_000 }));

    const restarting = prepared.scenarioContext.restartGatewayAfterStateMutation?.(mutateState, {
      timeoutMs: 2_000,
    });
    await vi.runAllTimersAsync();
    await restarting;

    expect(mutateState).toHaveBeenCalledOnce();
    expect(statusReadCount).toBe(6);
  });
});
