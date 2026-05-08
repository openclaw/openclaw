import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentkitPluginConfig } from "./config.js";
import { saveAgentkitHitlGrant } from "./hitl-grants.js";
import { createAgentkitBeforeToolCallHook } from "./hitl.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createApi() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentkit-hitl-hook-"));
  tempDirs.push(dir);
  const config = {
    plugins: {
      entries: {
        agentkit: {
          enabled: true,
          config: {
            hitl: {
              enabled: true,
              mode: "delegation",
              resourceUrl: "http://127.0.0.1:4126/protected" as string | null,
              protectedTools: ["bash"],
              grantsFile: path.join(dir, "grants.json"),
              humanApproval: {} as Record<string, string>,
            },
          },
        },
      },
    },
  };
  return createTestPluginApi({
    id: "agentkit",
    name: "AgentKit",
    source: "test",
    registrationMode: "full",
    config,
    pluginConfig: config.plugins.entries.agentkit.config,
    runtime: {
      config: {
        current: () => config,
      },
    } as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    resolvePath(input: string) {
      return input;
    },
    on() {},
  }) as OpenClawPluginApi & {
    config: typeof config;
    pluginConfig: typeof config.plugins.entries.agentkit.config;
  };
}

describe("agentkit before_tool_call HITL hook", () => {
  it("does not block tools that are not protected", async () => {
    const api = await createApi();
    const hook = createAgentkitBeforeToolCallHook(api);
    const result = await hook(
      { toolName: "browser", params: {} },
      { toolName: "browser", sessionKey: "agent:main:test", agentId: "main" },
    );

    expect(result).toBeUndefined();
  });

  it("requests approval when a protected tool has no delegation grant", async () => {
    const api = await createApi();
    const hook = createAgentkitBeforeToolCallHook(api);
    const result = await hook(
      { toolName: "bash", params: {} },
      { toolName: "bash", sessionKey: "agent:main:test", agentId: "main" },
    );

    expect(result?.requireApproval?.title).toBe("World proof required for bash");
    expect(result?.requireApproval?.description).toContain("World proof of human is required");
    expect(result?.requireApproval?.description?.length).toBeLessThanOrEqual(256);
    expect(result?.requireApproval?.pluginId).toBe("agentkit");
    expect(result?.requireApproval?.allowedDecisions).toEqual(["deny"]);
    expect(result?.requireApproval?.keepPendingWithoutRoute).toBe(true);
  });

  it("mentions QR approval guidance in human-approval mode", async () => {
    const api = await createApi();
    api.config.plugins.entries.agentkit.config.hitl.mode = "human-approval";
    api.config.plugins.entries.agentkit.config.hitl.resourceUrl = null;
    api.config.plugins.entries.agentkit.config.hitl.humanApproval = {
      appId: "app_test",
      rpId: "rp_test",
      signingKey: "0xabc",
    };
    const hook = createAgentkitBeforeToolCallHook(api);
    const result = await hook(
      { toolName: "bash", params: {} },
      { toolName: "bash", sessionKey: "agent:main:test", agentId: "main" },
    );

    expect(result?.requireApproval?.description).toContain("Verify with World");
    expect(result?.requireApproval?.description).not.toContain("--private-key-file");
    expect(result?.requireApproval?.pluginId).toBe("agentkit");
    expect(result?.requireApproval?.allowedDecisions).toEqual(["deny"]);
    expect(result?.requireApproval?.actions).toEqual([
      {
        kind: "command",
        label: "Verify with World (Once)",
        style: "primary",
        commandTemplate: "/agentkit approve {id} allow-once",
      },
      {
        kind: "command",
        label: "Verify and trust for session",
        style: "success",
        commandTemplate: "/agentkit approve {id} allow-always",
      },
      {
        kind: "decision",
        label: "Deny",
        style: "danger",
        decision: "deny",
        commandTemplate: "/approve {id} deny",
      },
    ]);
  });

  it("allows a protected tool when a matching delegation grant exists", async () => {
    const api = await createApi();
    const pluginConfig = resolveAgentkitPluginConfig(api.config.plugins?.entries?.agentkit?.config);
    saveAgentkitHitlGrant({
      pluginConfig,
      grant: {
        id: "grant-1",
        approvalMode: "delegation",
        resourceUrl: "http://127.0.0.1:4126/protected",
        decision: "allow-once",
        scope: {
          toolName: "bash",
          sessionKey: "agent:main:test",
          agentId: "main",
        },
        humanLookupMode: "local-trust-verified-signer",
        signerAddress: "0xabc",
        proofNullifier: null,
        grantedAtMs: Date.now(),
        expiresAtMs: null,
        consumedAtMs: null,
      },
    });

    const hook = createAgentkitBeforeToolCallHook(api);
    const result = await hook(
      { toolName: "bash", params: {} },
      { toolName: "bash", sessionKey: "agent:main:test", agentId: "main" },
    );

    expect(result).toBeUndefined();
  });
});
