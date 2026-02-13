import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  createCliportDaemon: vi.fn(() => ({
    start: mocks.start,
    stop: mocks.stop,
    isRunning: () => false,
  })),
}));

vi.mock("./daemon.js", () => ({
  createCliportDaemon: (...args: unknown[]) => mocks.createCliportDaemon(...args),
}));

import { createCliportService } from "./service.js";

function makeCtx(overrides?: Partial<Record<string, unknown>>) {
  return {
    workspaceDir: "/tmp/workspace",
    stateDir: "/tmp/state",
    config: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...(overrides ?? {}),
  };
}

describe("cliport service startup guard", () => {
  const originalSocketPath = process.env.CLIPORT_SOCKET_PATH;

  beforeEach(() => {
    mocks.start.mockClear();
    mocks.stop.mockClear();
    mocks.createCliportDaemon.mockClear();
    delete process.env.CLIPORT_SOCKET_PATH;
  });

  afterEach(() => {
    if (typeof originalSocketPath === "string") {
      process.env.CLIPORT_SOCKET_PATH = originalSocketPath;
      return;
    }
    delete process.env.CLIPORT_SOCKET_PATH;
  });

  it("blocks startup when cliport socket bind exists and elevated is enabled", async () => {
    const service = createCliportService();
    const ctx = makeCtx({
      config: {
        tools: { elevated: { enabled: true } },
        agents: {
          defaults: {
            sandbox: {
              docker: {
                binds: ["/var/run/cliport.sock:/var/run/cliport.sock:ro"],
              },
            },
          },
        },
      },
    });
    await expect(service.start(ctx as never)).rejects.toThrow(
      "tools.elevated.enabled must be false",
    );
    expect(mocks.createCliportDaemon).not.toHaveBeenCalled();
  });

  it("blocks startup when elevated config is omitted (defaults to enabled) and cliport socket bind exists", async () => {
    const service = createCliportService();
    const ctx = makeCtx({
      config: {
        agents: {
          defaults: {
            sandbox: {
              docker: {
                binds: ["/var/run/cliport.sock:/var/run/cliport.sock:ro"],
              },
            },
          },
        },
      },
    });
    await expect(service.start(ctx as never)).rejects.toThrow(
      "tools.elevated.enabled must be false",
    );
    expect(mocks.createCliportDaemon).not.toHaveBeenCalled();
  });

  it("allows startup when elevated mode is disabled", async () => {
    const service = createCliportService();
    const ctx = makeCtx({
      config: {
        tools: { elevated: { enabled: false } },
        agents: {
          defaults: {
            sandbox: {
              docker: {
                binds: ["/var/run/cliport.sock:/var/run/cliport.sock:ro"],
              },
            },
          },
        },
      },
    });
    await service.start(ctx as never);
    expect(mocks.createCliportDaemon).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it("blocks startup for custom socket path when elevated mode is enabled", async () => {
    process.env.CLIPORT_SOCKET_PATH = "/tmp/openclaw/cliport-custom.sock";
    const service = createCliportService();
    const ctx = makeCtx({
      config: {
        tools: { elevated: { enabled: true } },
        agents: {
          defaults: {
            sandbox: {
              docker: {
                binds: ["/tmp/openclaw/cliport-custom.sock:/tmp/openclaw/cliport-custom.sock:ro"],
              },
            },
          },
        },
      },
    });
    await expect(service.start(ctx as never)).rejects.toThrow(
      "tools.elevated.enabled must be false",
    );
    expect(mocks.createCliportDaemon).not.toHaveBeenCalled();
  });

  it("allows startup when configured socket path is not bound", async () => {
    process.env.CLIPORT_SOCKET_PATH = "/tmp/openclaw/cliport-custom.sock";
    const service = createCliportService();
    const ctx = makeCtx({
      config: {
        tools: { elevated: { enabled: true } },
        agents: {
          defaults: {
            sandbox: {
              docker: {
                binds: ["/var/run/cliport.sock:/var/run/cliport.sock:ro"],
              },
            },
          },
        },
      },
    });
    await service.start(ctx as never);
    expect(mocks.createCliportDaemon).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
});
