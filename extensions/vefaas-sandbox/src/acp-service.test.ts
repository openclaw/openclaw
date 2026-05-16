import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveVefaasPluginConfig } from "./config.js";

const { runtimeRegistry } = vi.hoisted(() => ({
  runtimeRegistry: new Map<string, { runtime: unknown }>(),
}));

const { acpxRuntimeConstructorMock, createAgentRegistryMock, createFileSessionStoreMock } =
  vi.hoisted(() => ({
    acpxRuntimeConstructorMock: vi.fn(function AcpxRuntime(options: unknown) {
      return {
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        ensureSession: vi.fn(async () => ({
          backend: "vefaas-opencode",
          runtimeSessionName: "agent:opencode:acp:test",
          sessionKey: "agent:opencode:acp:test",
        })),
        runTurn: vi.fn(async function* () {}),
        __options: options,
      };
    }),
    createAgentRegistryMock: vi.fn(() => ({})),
    createFileSessionStoreMock: vi.fn(() => ({})),
  }));

vi.mock("openclaw/plugin-sdk/acp-runtime-backend", () => ({
  registerAcpRuntimeBackend: (entry: { id: string; runtime: unknown }) => {
    runtimeRegistry.set(entry.id, entry);
  },
  unregisterAcpRuntimeBackend: (id: string) => {
    runtimeRegistry.delete(id);
  },
}));

vi.mock("acpx/runtime", () => ({
  AcpxRuntime: acpxRuntimeConstructorMock,
  createAgentRegistry: createAgentRegistryMock,
  createFileSessionStore: createFileSessionStoreMock,
}));

import {
  createVefaasOpencodeAcpService,
  VEFAAS_OPENCODE_ACP_BACKEND_ID,
} from "./acp-service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  runtimeRegistry.clear();
  acpxRuntimeConstructorMock.mockClear();
  createAgentRegistryMock.mockClear();
  createFileSessionStoreMock.mockClear();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-vefaas-acp-service-"));
  tempDirs.push(dir);
  return dir;
}

function createServiceContext(workspaceDir: string) {
  return {
    workspaceDir,
    stateDir: path.join(workspaceDir, ".openclaw-plugin-state"),
    config: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

describe("createVefaasOpencodeAcpService", () => {
  it("does not register the ACP backend unless opencode ACP is enabled", async () => {
    const workspaceDir = await makeTempDir();
    const service = createVefaasOpencodeAcpService({
      pluginConfig: resolveVefaasPluginConfig(undefined),
    });

    await service.start?.(createServiceContext(workspaceDir));

    expect(runtimeRegistry.has(VEFAAS_OPENCODE_ACP_BACKEND_ID)).toBe(false);
    expect(acpxRuntimeConstructorMock).not.toHaveBeenCalled();
  });

  it("registers vefaas-opencode with the local VEFaaS proxy command", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const service = createVefaasOpencodeAcpService({
      pluginConfig: resolveVefaasPluginConfig({
        functionId: "fn-123",
        region: "cn-beijing",
        timeoutSeconds: 45,
        opencode: {
          acp: true,
          env: {
            OPENAI_BASE_URL: "https://openai.example",
          },
        },
      }),
    });

    await service.start?.(ctx);

    expect(runtimeRegistry.has(VEFAAS_OPENCODE_ACP_BACKEND_ID)).toBe(true);
    expect(createFileSessionStoreMock).toHaveBeenCalledWith({
      stateDir: path.join(ctx.stateDir, "vefaas-opencode-acp"),
    });
    expect(createAgentRegistryMock).toHaveBeenCalledTimes(1);
    const registryOptions = createAgentRegistryMock.mock.calls[0]?.[0] as {
      overrides?: Record<string, string>;
    };
    expect(registryOptions.overrides?.opencode).toContain("opencode-acp-proxy.mjs");
    expect(registryOptions.overrides?.opencode).toContain("--config");

    const runtimeOptions = acpxRuntimeConstructorMock.mock.calls[0]?.[0] as {
      cwd?: string;
      permissionMode?: string;
      nonInteractivePermissions?: string;
      timeoutMs?: number;
    };
    expect(runtimeOptions).toMatchObject({
      cwd: workspaceDir,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      timeoutMs: 45_000,
    });

    const configPath = path.join(ctx.stateDir, "vefaas-opencode-acp", "vefaas-config.json");
    await expect(fs.readFile(configPath, "utf8")).resolves.toContain('"functionId":"fn-123"');
  });

  it("unregisters the ACP backend on stop", async () => {
    const workspaceDir = await makeTempDir();
    const service = createVefaasOpencodeAcpService({
      pluginConfig: resolveVefaasPluginConfig({
        opencode: {
          acp: true,
        },
      }),
    });

    await service.start?.(createServiceContext(workspaceDir));
    service.stop?.();

    expect(runtimeRegistry.has(VEFAAS_OPENCODE_ACP_BACKEND_ID)).toBe(false);
  });
});
