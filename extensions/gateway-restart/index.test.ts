import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({
  default: fsMocks,
  ...fsMocks,
}));

vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
}));

// Suppress process.exit in tool execute
vi.spyOn(global, "setTimeout").mockImplementation(
  () => 0 as unknown as ReturnType<typeof setTimeout>,
);

import gatewayRestartPlugin from "./index.js";

const STATE_DIR = "/tmp/gateway-restart-state";
const MARKER_FILE = "restart-pending.json";
const MARKER_PATH = `${STATE_DIR}/${MARKER_FILE}`;

function createApi() {
  const registerTool = vi.fn();
  const registerService = vi.fn();
  const followupRuntime = {
    enqueueFollowupTurn: vi.fn(),
  };

  const api = createTestPluginApi({
    id: "gateway-restart",
    name: "Gateway Restart",
    source: "test",
    config: {},
    runtime: {
      followup: followupRuntime,
      state: {
        resolveStateDir: vi.fn().mockReturnValue(STATE_DIR),
      },
    } as unknown as NonNullable<Parameters<typeof createTestPluginApi>[0]>["runtime"],
    registerTool,
    registerService,
  });

  return { api, registerTool, registerService, followupRuntime };
}

function getRegisteredTool(registerTool: ReturnType<typeof vi.fn>) {
  const call = registerTool.mock.calls[0]?.[0];
  if (!call) {
    throw new Error("No tool registered");
  }
  return call as { execute: (toolCallId: string, params: unknown) => Promise<unknown> };
}

function getRegisteredService(registerService: ReturnType<typeof vi.fn>) {
  const call = registerService.mock.calls[0]?.[0];
  if (!call) {
    throw new Error("No service registered");
  }
  return call as { start: (ctx: unknown) => Promise<void> };
}

function makeServiceCtx(overrides: Partial<{ stateDir: string }> = {}) {
  return {
    stateDir: overrides.stateDir ?? STATE_DIR,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fsMocks.mkdirSync.mockReturnValue(undefined);
  fsMocks.writeFileSync.mockReturnValue(undefined);
  fsMocks.rmSync.mockReturnValue(undefined);
  execSyncMock.mockReturnValue("success output\n");
});

describe("gateway-restart plugin tool", () => {
  it("rejects commands not in allowlist", async () => {
    const { api, registerTool } = createApi();
    await gatewayRestartPlugin.register(api);

    const tool = getRegisteredTool(registerTool);
    const result = (await tool.execute("call-1", {
      sessionKey: "agent:main:telegram:direct:123",
      commands: ["rm -rf /"],
    })) as { content: { text: string }[] };

    expect(result.content[0]?.text).toMatch(/not allowed/i);
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
  });

  it("writes marker after pre-commands succeed", async () => {
    const { api, registerTool } = createApi();
    await gatewayRestartPlugin.register(api);

    const tool = getRegisteredTool(registerTool);
    execSyncMock.mockReturnValue("installed\n");

    await tool.execute("call-2", {
      sessionKey: "agent:main:telegram:direct:123",
      commands: ["openclaw gateway install --force"],
      reason: "upgrade",
    });

    expect(execSyncMock).toHaveBeenCalledWith(
      "openclaw gateway install --force",
      expect.objectContaining({ encoding: "utf8" }),
    );
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      MARKER_PATH,
      expect.stringContaining("agent:main:telegram:direct:123"),
      "utf8",
    );
  });

  it("does not write marker when pre-command fails", async () => {
    const { api, registerTool } = createApi();
    await gatewayRestartPlugin.register(api);

    const tool = getRegisteredTool(registerTool);
    execSyncMock.mockImplementation(() => {
      throw new Error("command failed");
    });

    const result = (await tool.execute("call-3", {
      sessionKey: "agent:main:telegram:direct:123",
      commands: ["openclaw gateway install --force"],
    })) as { content: Array<{ text: string }> };
    expect(result.content[0]?.text).toContain("ERROR: Pre-restart command failed");

    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
  });
});

describe("gateway-restart plugin watcher service", () => {
  it("does nothing when no marker exists", async () => {
    const { api, registerService, followupRuntime } = createApi();
    await gatewayRestartPlugin.register(api);

    fsMocks.existsSync.mockReturnValue(false);

    const service = getRegisteredService(registerService);
    await service.start(makeServiceCtx());

    expect(followupRuntime.enqueueFollowupTurn).not.toHaveBeenCalled();
  });

  it("enqueues followup and deletes marker on success", async () => {
    const { api, registerService, followupRuntime } = createApi();
    await gatewayRestartPlugin.register(api);

    const marker = {
      sessionKey: "agent:main:telegram:direct:123",
      requestedAt: new Date().toISOString(),
      preCommands: [],
      reason: "test restart",
      message: "All done",
    };
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(JSON.stringify(marker, null, 2));
    followupRuntime.enqueueFollowupTurn.mockResolvedValue(true);

    const service = getRegisteredService(registerService);
    await service.start(makeServiceCtx());

    expect(followupRuntime.enqueueFollowupTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:direct:123",
        source: "gateway-restart",
      }),
    );
    expect(fsMocks.rmSync).toHaveBeenCalledWith(MARKER_PATH, { force: true });
  });

  it("leaves marker when enqueue fails", async () => {
    const { api, registerService, followupRuntime } = createApi();
    await gatewayRestartPlugin.register(api);

    const marker = {
      sessionKey: "agent:main:telegram:direct:123",
      requestedAt: new Date().toISOString(),
      preCommands: [],
    };
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(JSON.stringify(marker, null, 2));
    followupRuntime.enqueueFollowupTurn.mockResolvedValue(false);

    const service = getRegisteredService(registerService);
    await service.start(makeServiceCtx());

    expect(followupRuntime.enqueueFollowupTurn).toHaveBeenCalled();
    expect(fsMocks.rmSync).not.toHaveBeenCalled();
  });
});
