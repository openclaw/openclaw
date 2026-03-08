import { beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_BRIDGES } from "./browser-bridges.js";
import {
  applySandboxBridgeAccessToDockerConfig,
  ensureSandboxBrowser,
  resolveSandboxBrowserCdpTarget,
  isDockerizedSandboxGatewayRuntime,
  resolveSandboxBrowserCdpHost,
  resolveSandboxBridgeAccess,
} from "./browser.js";
import { resetNoVncObserverTokensForTests } from "./novnc-auth.js";
import { collectDockerFlagValues, findDockerArgsCall } from "./test-args.js";
import type { SandboxConfig } from "./types.js";

const dockerMocks = vi.hoisted(() => ({
  dockerContainerState: vi.fn(),
  execDocker: vi.fn(),
  readDockerContainerEnvVar: vi.fn(),
  readDockerContainerLabel: vi.fn(),
  readDockerPort: vi.fn(),
}));

const registryMocks = vi.hoisted(() => ({
  readBrowserRegistry: vi.fn(),
  updateBrowserRegistry: vi.fn(),
}));

const bridgeMocks = vi.hoisted(() => ({
  startBrowserBridgeServer: vi.fn(),
  stopBrowserBridgeServer: vi.fn(),
}));

vi.mock("./docker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./docker.js")>();
  return {
    ...actual,
    dockerContainerState: dockerMocks.dockerContainerState,
    execDocker: dockerMocks.execDocker,
    readDockerContainerEnvVar: dockerMocks.readDockerContainerEnvVar,
    readDockerContainerLabel: dockerMocks.readDockerContainerLabel,
    readDockerPort: dockerMocks.readDockerPort,
  };
});

vi.mock("./registry.js", () => ({
  readBrowserRegistry: registryMocks.readBrowserRegistry,
  updateBrowserRegistry: registryMocks.updateBrowserRegistry,
}));

vi.mock("../../browser/bridge-server.js", () => ({
  startBrowserBridgeServer: bridgeMocks.startBrowserBridgeServer,
  stopBrowserBridgeServer: bridgeMocks.stopBrowserBridgeServer,
}));

function buildConfig(enableNoVnc: boolean): SandboxConfig {
  return {
    mode: "all",
    scope: "session",
    workspaceAccess: "none",
    workspaceRoot: "/tmp/openclaw-sandboxes",
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      network: "none",
      capDrop: ["ALL"],
      env: { LANG: "C.UTF-8" },
    },
    browser: {
      enabled: true,
      image: "openclaw-sandbox-browser:bookworm-slim",
      containerPrefix: "openclaw-sbx-browser-",
      network: "openclaw-sandbox-browser",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: false,
      enableNoVnc,
      allowHostControl: false,
      autoStart: true,
      autoStartTimeoutMs: 12_000,
    },
    tools: {
      allow: ["browser"],
      deny: [],
    },
    prune: {
      idleHours: 24,
      maxAgeDays: 7,
    },
  };
}

describe("ensureSandboxBrowser create args", () => {
  beforeEach(() => {
    BROWSER_BRIDGES.clear();
    resetNoVncObserverTokensForTests();
    dockerMocks.dockerContainerState.mockClear();
    dockerMocks.execDocker.mockClear();
    dockerMocks.readDockerContainerEnvVar.mockClear();
    dockerMocks.readDockerContainerLabel.mockClear();
    dockerMocks.readDockerPort.mockClear();
    registryMocks.readBrowserRegistry.mockClear();
    registryMocks.updateBrowserRegistry.mockClear();
    bridgeMocks.startBrowserBridgeServer.mockClear();
    bridgeMocks.stopBrowserBridgeServer.mockClear();

    dockerMocks.dockerContainerState.mockResolvedValue({ exists: false, running: false });
    dockerMocks.execDocker.mockImplementation(async (args: string[]) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: "[]", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    dockerMocks.readDockerContainerLabel.mockResolvedValue(null);
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue(null);
    dockerMocks.readDockerPort.mockImplementation(async (_containerName: string, port: number) => {
      if (port === 9222) {
        return 49100;
      }
      if (port === 6080) {
        return 49101;
      }
      return null;
    });
    registryMocks.readBrowserRegistry.mockResolvedValue({ entries: [] });
    registryMocks.updateBrowserRegistry.mockResolvedValue(undefined);
    bridgeMocks.startBrowserBridgeServer.mockResolvedValue({
      server: {} as never,
      port: 19000,
      baseUrl: "http://127.0.0.1:19000",
      advertisedBaseUrl: "http://host.docker.internal:19000",
      state: {
        server: null,
        port: 19000,
        resolved: { profiles: {} },
        profiles: new Map(),
      },
    });
    bridgeMocks.stopBrowserBridgeServer.mockResolvedValue(undefined);
  });

  it("publishes noVNC on loopback and injects noVNC password env", async () => {
    const result = await ensureSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(true),
    });

    const createArgs = findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create");

    expect(createArgs).toBeDefined();
    expect(createArgs).toContain("127.0.0.1::6080");
    const envEntries = collectDockerFlagValues(createArgs ?? [], "-e");
    expect(envEntries).toContain("OPENCLAW_BROWSER_NO_SANDBOX=1");
    const passwordEntry = envEntries.find((entry) =>
      entry.startsWith("OPENCLAW_BROWSER_NOVNC_PASSWORD="),
    );
    expect(passwordEntry).toMatch(/^OPENCLAW_BROWSER_NOVNC_PASSWORD=[A-Za-z0-9]{8}$/);
    expect(result?.bridgeUrl).toBe("http://127.0.0.1:19000");
    expect(result?.advertisedBridgeUrl).toBe("http://host.docker.internal:19000");
    expect(result?.noVncUrl).toMatch(/^http:\/\/127\.0\.0\.1:19000\/sandbox\/novnc\?token=/);
    expect(result?.noVncUrl).not.toContain("password=");
    expect(bridgeMocks.startBrowserBridgeServer).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "0.0.0.0",
        advertisedHost: "host.docker.internal",
        allowNonLoopbackHost: true,
      }),
    );
  });

  it("does not inject noVNC password env when noVNC is disabled", async () => {
    const result = await ensureSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildConfig(false),
    });

    const createArgs = findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create");
    const envEntries = collectDockerFlagValues(createArgs ?? [], "-e");
    expect(envEntries.some((entry) => entry.startsWith("OPENCLAW_BROWSER_NOVNC_PASSWORD="))).toBe(
      false,
    );
    expect(result?.noVncUrl).toBeUndefined();
  });

  it("mounts the main workspace read-only when workspaceAccess is none", async () => {
    const cfg = buildConfig(false);
    cfg.workspaceAccess = "none";

    await ensureSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg,
    });

    const createArgs = findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create");

    expect(createArgs).toBeDefined();
    expect(createArgs).toContain("/tmp/workspace:/workspace:ro");
  });

  it("keeps the main workspace writable when workspaceAccess is rw", async () => {
    const cfg = buildConfig(false);
    cfg.workspaceAccess = "rw";

    await ensureSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg,
    });

    const createArgs = findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create");

    expect(createArgs).toBeDefined();
    expect(createArgs).toContain("/tmp/workspace:/workspace");
    expect(createArgs).not.toContain("/tmp/workspace:/workspace:ro");
  });

  it("adds host-gateway alias for linux sandbox containers", () => {
    const resolved = applySandboxBridgeAccessToDockerConfig({
      cfg: buildConfig(false),
      platform: "linux",
    });

    expect(resolved.docker.extraHosts).toContain("host.docker.internal:host-gateway");
  });

  it("does not duplicate host-gateway alias when already configured", () => {
    const cfg = buildConfig(false);
    cfg.docker.extraHosts = ["host.docker.internal:host-gateway"];

    const resolved = applySandboxBridgeAccessToDockerConfig({
      cfg,
      platform: "linux",
    });

    expect(resolved.docker.extraHosts).toEqual(["host.docker.internal:host-gateway"]);
  });

  it("honors explicit bridgeHost override", () => {
    const access = resolveSandboxBridgeAccess({
      browserHost: "gateway.internal",
      dockerExtraHosts: [],
      platform: "linux",
    });

    expect(access).toEqual({
      listenHost: "0.0.0.0",
      advertisedHost: "gateway.internal",
    });
  });

  it("defaults sandbox browser CDP host to loopback outside Dockerized gateway runtimes", async () => {
    await expect(resolveSandboxBrowserCdpHost({ dockerizedGatewayRuntime: false })).resolves.toBe(
      "127.0.0.1",
    );
  });

  it("uses the mapped CDP port for non-Dockerized gateway runtimes", async () => {
    await expect(
      resolveSandboxBrowserCdpTarget({
        dockerizedGatewayRuntime: false,
        mappedCdpPort: 49100,
        internalCdpPort: 9222,
      }),
    ).resolves.toEqual({
      host: "127.0.0.1",
      port: 49100,
    });
  });

  it("falls back to the Docker host alias when no direct gateway network path is available", async () => {
    await expect(resolveSandboxBrowserCdpHost({ dockerizedGatewayRuntime: true })).resolves.toBe(
      "host.docker.internal",
    );
  });

  it("falls back to the mapped CDP port when only the Docker host alias is available", async () => {
    await expect(
      resolveSandboxBrowserCdpTarget({
        dockerizedGatewayRuntime: true,
        mappedCdpPort: 49100,
        internalCdpPort: 9222,
      }),
    ).resolves.toEqual({
      host: "host.docker.internal",
      port: 49100,
    });
  });

  it("detects Dockerized gateway runtime only when both dockerenv and docker.sock exist", () => {
    const paths = new Set(["/.dockerenv", "/var/run/docker.sock"]);
    expect(
      isDockerizedSandboxGatewayRuntime({
        existsSync: (path) => paths.has(path),
      }),
    ).toBe(true);
    expect(
      isDockerizedSandboxGatewayRuntime({
        existsSync: (path) => path === "/.dockerenv",
      }),
    ).toBe(false);
  });

  it("passes an explicit sandbox browser cdpHost into the bridge config", async () => {
    const cfg = buildConfig(false);
    cfg.browser.cdpHost = "gateway-host.internal";

    await ensureSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg,
    });

    expect(bridgeMocks.startBrowserBridgeServer).toHaveBeenCalledWith(
      expect.objectContaining({
        resolved: expect.objectContaining({
          cdpHost: "gateway-host.internal",
          cdpIsLoopback: false,
          profiles: {
            openclaw: expect.objectContaining({
              cdpPort: 49100,
            }),
          },
        }),
      }),
    );
  });

  it("uses the browser container IP on the shared gateway network for Dockerized runtimes", async () => {
    const originalHostname = process.env.HOSTNAME;
    try {
      process.env.HOSTNAME = "gateway-container";
      let browserInspectCount = 0;
      dockerMocks.execDocker.mockImplementation(async (args: string[]) => {
        if (args[0] === "inspect" && args[1] === "gateway-container") {
          return {
            stdout: JSON.stringify([
              {
                NetworkSettings: {
                  Networks: {
                    openclaw_default: { IPAddress: "172.18.0.2" },
                  },
                },
              },
            ]),
            stderr: "",
            code: 0,
          };
        }
        if (args[0] === "inspect" && args[1] === "sandbox-browser") {
          browserInspectCount += 1;
          return {
            stdout: JSON.stringify([
              {
                NetworkSettings: {
                  Networks:
                    browserInspectCount === 1
                      ? {}
                      : {
                          openclaw_default: { IPAddress: "172.18.0.3" },
                        },
                },
              },
            ]),
            stderr: "",
            code: 0,
          };
        }
        if (args[0] === "network" && args[1] === "connect") {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (args[0] === "image" && args[1] === "inspect") {
          return { stdout: "[]", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      });

      await expect(
        resolveSandboxBrowserCdpHost({
          containerName: "sandbox-browser",
          dockerizedGatewayRuntime: true,
        }),
      ).resolves.toBe("172.18.0.3");
      await expect(
        resolveSandboxBrowserCdpTarget({
          containerName: "sandbox-browser",
          dockerizedGatewayRuntime: true,
          mappedCdpPort: 49100,
          internalCdpPort: 9222,
        }),
      ).resolves.toEqual({
        host: "172.18.0.3",
        port: 9222,
      });
      expect(dockerMocks.execDocker).toHaveBeenCalledWith(
        ["network", "connect", "--alias", "sandbox-browser", "openclaw_default", "sandbox-browser"],
        { allowFailure: true },
      );
    } finally {
      process.env.HOSTNAME = originalHostname;
    }
  });
});
