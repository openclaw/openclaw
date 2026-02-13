import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildSandboxCreateArgsMock,
  dockerContainerStateMock,
  execDockerMock,
  readDockerPortMock,
  startBrowserBridgeServerMock,
} = vi.hoisted(() => ({
  buildSandboxCreateArgsMock: vi.fn((params?: { cfg?: { network?: string } }) => [
    "create",
    "--network",
    params?.cfg?.network ?? "none",
  ]),
  dockerContainerStateMock: vi.fn(async () => ({ exists: false, running: false })),
  execDockerMock: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
  readDockerPortMock: vi.fn(async () => 9222),
  startBrowserBridgeServerMock: vi.fn(async () => ({
    baseUrl: "http://127.0.0.1:7777",
    server: {},
    state: {
      resolved: {
        profiles: {
          openclaw: {
            cdpPort: 9222,
            color: "#FF4500",
          },
        },
      },
    },
  })),
}));

vi.mock("./docker.js", () => ({
  buildSandboxCreateArgs: (...args: unknown[]) => buildSandboxCreateArgsMock(...args),
  dockerContainerState: (...args: unknown[]) => dockerContainerStateMock(...args),
  execDocker: (...args: unknown[]) => execDockerMock(...args),
  readDockerPort: (...args: unknown[]) => readDockerPortMock(...args),
}));

vi.mock("../../browser/bridge-server.js", () => ({
  startBrowserBridgeServer: (...args: unknown[]) => startBrowserBridgeServerMock(...args),
  stopBrowserBridgeServer: vi.fn(async () => undefined),
}));

vi.mock("./registry.js", () => ({
  updateBrowserRegistry: vi.fn(async () => undefined),
}));

import { BROWSER_BRIDGES } from "./browser-bridges.js";
import { ensureSandboxBrowser } from "./browser.js";

describe("ensureSandboxBrowser network override", () => {
  beforeEach(() => {
    BROWSER_BRIDGES.clear();
    buildSandboxCreateArgsMock.mockClear();
    dockerContainerStateMock.mockClear();
    execDockerMock.mockClear();
    readDockerPortMock.mockClear();
    startBrowserBridgeServerMock.mockClear();
  });

  it("uses browser.network when creating browser container", async () => {
    await ensureSandboxBrowser({
      scopeKey: "session-main",
      workspaceDir: "/tmp/sandbox-copy",
      agentWorkspaceDir: "/tmp/agent-workspace",
      cfg: {
        mode: "all",
        scope: "agent",
        workspaceAccess: "ro",
        workspaceRoot: "/tmp",
        docker: {
          image: "sandbox-image",
          containerPrefix: "openclaw-sandbox-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp"],
          network: "none",
          capDrop: ["ALL"],
          env: {},
        },
        browser: {
          enabled: true,
          image: "sandbox-browser-image",
          network: "bridge",
          containerPrefix: "openclaw-browser-",
          cdpPort: 9222,
          vncPort: 5900,
          noVncPort: 6080,
          headless: true,
          enableNoVnc: false,
          allowHostControl: false,
          autoStart: false,
          autoStartTimeoutMs: 5000,
        },
        tools: {},
        prune: { idleHours: 24, maxAgeDays: 7 },
      },
    });

    const createCall = execDockerMock.mock.calls.find((call) => {
      const args = call[0] as string[];
      return Array.isArray(args) && args[0] === "create";
    });
    expect(createCall).toBeDefined();
    const args = createCall?.[0] as string[];
    const networkIndex = args.indexOf("--network");
    expect(networkIndex).toBeGreaterThan(-1);
    expect(args[networkIndex + 1]).toBe("bridge");
    const buildArgsCall = buildSandboxCreateArgsMock.mock.calls[0]?.[0] as {
      cfg?: { network?: string };
    };
    expect(buildArgsCall?.cfg?.network).toBe("bridge");
  });
});
