import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  prepareCodexNativeExecutionPolicy,
  resolveCodexNativeExecutionPolicy,
} from "./native-execution-policy.js";

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));

vi.mock("openclaw/plugin-sdk/session-binding-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/session-binding-runtime")>()),
  captureSessionEntryCurrentCheckAsync: capture,
}));

function mockSelectedEntry(execNode: string) {
  const release = vi.fn();
  capture.mockResolvedValue({
    entry: { sessionId: "session-1", updatedAt: 1, execHost: "node", execNode },
    isCurrent: async () => true,
    async assertCurrent() {},
    release,
  });
  onTestFinished(release);
}

function resolvePolicy(
  overrides: Partial<Parameters<typeof resolveCodexNativeExecutionPolicy>[0]>,
) {
  return resolveCodexNativeExecutionPolicy({
    sessionEntry: null,
    config: { tools: { exec: { host: "auto" } } },
    sessionKey: "session-1",
    ...overrides,
  });
}

async function preparePolicy(overrides: Parameters<typeof prepareCodexNativeExecutionPolicy>[0]) {
  return (
    await prepareCodexNativeExecutionPolicy({
      config: { tools: { exec: { host: "gateway" } } },
      readRuntimeSessionEntry: true,
      ...overrides,
    })
  ).policy;
}

const gatewayPolicy = {
  nativeToolSurfaceAllowed: true,
  requestedExecHost: "gateway",
  effectiveExecHost: "gateway",
};
function nodePolicy(node: string) {
  return {
    nativeToolSurfaceAllowed: false,
    requestedExecHost: "node",
    effectiveExecHost: "node",
    node,
  };
}
const multiAgentConfig = {
  tools: { exec: { host: "gateway" as const } },
  agents: { entries: { alpha: {}, beta: {} } },
};

describe("resolveCodexNativeExecutionPolicy", () => {
  beforeEach(() => capture.mockReset());

  it.each([
    ["gateway", false],
    ["sandbox", true],
  ] as const)(
    "resolves auto to %s with sandbox available=%s",
    (effectiveExecHost, sandboxAvailable) => {
      expect(resolvePolicy({ sandboxAvailable })).toMatchObject({
        nativeToolSurfaceAllowed: true,
        requestedExecHost: "auto",
        effectiveExecHost,
      });
    },
  );

  it("honors per-attempt node exec overrides before config defaults", () => {
    expect(
      resolvePolicy({
        config: { tools: { exec: { host: "gateway" } } },
        execOverrides: { host: "node", node: "worker-2" },
      }),
    ).toMatchObject(nodePolicy("worker-2"));
  });

  it("preserves a storage refusal instead of falling back to gateway execution", async () => {
    const refusal = new Error("The selected session is no longer current");
    capture.mockImplementation(() => {
      throw refusal;
    });
    await expect(
      preparePolicy({
        sessionKey: "agent:main:dashboard:incognito-refused",
      }),
    ).rejects.toThrow(refusal);
  });

  it("honors persisted default-session exec hosts with explicit main agent policy", async () => {
    mockSelectedEntry("worker-5");

    expect(await preparePolicy({ sessionKey: "main", agentId: "main" })).toMatchObject(
      nodePolicy("worker-5"),
    );
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "main", agentId: "main" }),
    );
  });

  it("does not read an unscoped session entry for an explicit multi-agent roster", async () => {
    mockSelectedEntry("worker-6");

    expect(
      await preparePolicy({
        config: multiAgentConfig,
        sessionKey: "node-session",
        agentId: "alpha",
      }),
    ).toMatchObject(gatewayPolicy);
    expect(capture).not.toHaveBeenCalled();
  });

  it("uses global policy when an explicit multi-agent roster has no selected agent", async () => {
    mockSelectedEntry("worker-6");

    expect(
      await preparePolicy({
        config: multiAgentConfig,
        sessionKey: "node-session",
      }),
    ).toMatchObject(gatewayPolicy);
    expect(capture).not.toHaveBeenCalled();
  });

  it("honors agent exec config before global exec config", () => {
    expect(
      resolvePolicy({
        config: {
          tools: { exec: { host: "gateway" } },
          agents: {
            entries: { main: { tools: { exec: { host: "node", node: "worker-4" } } } },
          },
        },
        sessionKey: "agent:main:session-1",
      }),
    ).toMatchObject(nodePolicy("worker-4"));
  });
});
