import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  createCodexAppServerBindingStore,
  createStoredCodexAppServerBinding,
  hashCodexAppServerBindingFingerprint,
  readCodexAppServerThreadBinding,
} from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";

function importBinding(fields: Record<string, unknown>) {
  return createStoredCodexAppServerBinding({
    schemaVersion: 2,
    threadId: "thread-1",
    cwd: "/repo",
    ...fields,
  });
}

function pluginEntry(fields: Record<string, unknown>) {
  return {
    configKey: "app",
    marketplaceName: "openai-curated",
    pluginName: "plugin",
    allowDestructiveActions: true,
    mcpServerNames: [],
    ...fields,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
});

describe("Codex app-server binding codec", () => {
  it.each([
    { stored: "on-failure", expected: "on-request" },
    { stored: "untrusted", expected: "untrusted" },
  ])("reads persisted approval policy $stored as $expected", ({ stored, expected }) => {
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-policy",
        cwd: "/repo",
        approvalPolicy: stored,
        sandbox: "workspace-write",
      }),
    ).toEqual({
      threadId: "thread-policy",
      cwd: "/repo",
      approvalPolicy: expected,
      sandbox: "workspace-write",
    });
  });

  it("rejects unsafe marketplace names in imported plugin app ownership", () => {
    const imported = importBinding({
      pluginAppPolicyContext: {
        fingerprint: "unsafe-plugin-policy",
        apps: {
          github: pluginEntry({
            configKey: "security-review",
            marketplaceName: "../unsafe-marketplace",
            pluginName: "security-review",
            mcpServerNames: ["github"],
          }),
        },
        pluginAppIds: { "security-review": ["github"] },
        mcpServers: {},
        nativePlugins: {},
      },
    });

    expect(imported?.binding.pluginAppPolicyContext).toBeUndefined();
  });

  it("normalizes legacy fingerprints without rehashing canonical values", () => {
    const rawDynamicToolsFingerprint = JSON.stringify([{ name: "legacy_tool" }]);
    const rawUserMcpServersFingerprint = JSON.stringify({
      mcp_servers: { legacy: { command: "node" } },
    });
    const nativeSkillIsolationFingerprint = `sha256:${"b".repeat(64)}`;
    const imported = importBinding({
      updatedAt: "2026-01-01T00:00:00.000Z",
      dynamicToolsFingerprint: rawDynamicToolsFingerprint,
      nativeSkillIsolationFingerprint,
      userMcpServersFingerprint: rawUserMcpServersFingerprint,
    });
    expect(imported?.binding).toMatchObject({
      dynamicToolsFingerprint: hashCodexAppServerBindingFingerprint(rawDynamicToolsFingerprint),
      nativeSkillIsolationFingerprint,
      userMcpServersFingerprint: hashCodexAppServerBindingFingerprint(rawUserMcpServersFingerprint),
    });

    const existingHash = `sha256:${"a".repeat(64)}`;
    const canonical = importBinding({
      updatedAt: "2026-01-01T00:00:00.000Z",
      dynamicToolsFingerprint: "[]",
      userMcpServersFingerprint: existingHash,
    });
    expect(canonical?.binding).toMatchObject({
      dynamicToolsFingerprint: "[]",
      userMcpServersFingerprint: existingHash,
    });
  });

  it("canonicalizes undefined fields and preserves empty instruction snapshots in JSON-only plugin state", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-binding-state-"));
    try {
      const state = createCodexSqliteTestBindingStateStore({
        namespace: "app-server-thread-bindings-json-test",
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const store = createCodexAppServerBindingStore(state);
      const identity = { kind: "conversation" as const, bindingId: "binding-json" };

      await expect(
        store.mutate(identity, {
          kind: "set",
          binding: {
            threadId: "thread-json",
            cwd: "/repo",
            model: undefined,
            contextEngine: {
              schemaVersion: 1,
              engineId: "lossless-claw",
              policyFingerprint: "policy-1",
              projection: undefined,
            },
          },
        }),
      ).resolves.toBe(true);
      expect(state.lookup(bindingStoreKey(identity))).toEqual({
        version: 1,
        state: "active",
        binding: {
          threadId: "thread-json",
          cwd: "/repo",
          contextEngine: {
            schemaVersion: 1,
            engineId: "lossless-claw",
            policyFingerprint: "policy-1",
          },
        },
      });

      await expect(
        store.mutate(identity, {
          kind: "patch",
          threadId: "thread-json",
          patch: { contextEngine: undefined },
        }),
      ).resolves.toBe(true);
      expect(store.read(identity)).toEqual({
        threadId: "thread-json",
        cwd: "/repo",
      });
      expect(state.lookup(bindingStoreKey(identity))).not.toHaveProperty("lease");

      for (const snapshot of [undefined, "", "Follow the saved workspace instructions."]) {
        const binding = {
          threadId: "thread-json",
          cwd: "/repo",
          ...(snapshot !== undefined ? { agentWorkspaceDeveloperInstructions: snapshot } : {}),
        };
        await store.mutate(identity, { kind: "set", binding });
        expect(store.read(identity)).toEqual(binding);
        expect(state.lookup(bindingStoreKey(identity))).toEqual({
          version: 1,
          state: "active",
          binding,
        });
        const imported = importBinding({
          ...binding,
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
        expect(imported?.binding).toEqual({
          ...binding,
          historyCoveredThrough: "2026-01-01T00:00:00.000Z",
        });
      }

      await expect(store.mutate(identity, { kind: "clear" })).resolves.toBe(true);
      expect(store.read(identity)).toBeUndefined();
    } finally {
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("maps the legacy sidecar update timestamp to the history watermark", () => {
    const updatedAt = "2026-01-01T00:00:00.000Z";
    const stored = importBinding({
      schemaVersion: 1,
      createdAt: "2025-12-31T00:00:00.000Z",
      updatedAt,
    });

    expect(stored?.binding).toMatchObject({ historyCoveredThrough: updatedAt });
    expect(stored?.binding).not.toHaveProperty("createdAt");
    expect(stored?.binding).not.toHaveProperty("updatedAt");
  });

  it("normalizes version 1 destructive approval modes during import", () => {
    const stored = importBinding({
      schemaVersion: 1,
      pluginAppPolicyContext: {
        fingerprint: "policy-1",
        apps: {
          allow: pluginEntry({
            configKey: "allow",
            pluginName: "allow-plugin",
            destructiveApprovalMode: "auto",
          }),
          prompt: pluginEntry({
            configKey: "prompt",
            pluginName: "prompt-plugin",
            destructiveApprovalMode: "on-request",
          }),
        },
        pluginAppIds: {},
        mcpServers: {},
        nativePlugins: {},
      },
    });

    expect(stored?.binding.pluginAppPolicyContext?.apps.allow?.destructiveApprovalMode).toBe(
      "allow",
    );
    expect(stored?.binding.pluginAppPolicyContext?.apps.prompt?.destructiveApprovalMode).toBe(
      "auto",
    );
  });

  it("preserves legacy app policy when neither native MCP ownership map exists", () => {
    const policyContext = {
      fingerprint: "policy-1",
      apps: { app: pluginEntry({ destructiveApprovalMode: "allow" }) },
      pluginAppIds: {},
    };
    const stored = importBinding({
      schemaVersion: 1,
      pluginAppPolicyContext: policyContext,
    });

    expect(stored?.binding.pluginAppPolicyContext).toEqual(policyContext);
  });

  it("drops imported policy contexts with a forbidden appId field", () => {
    const invalid = importBinding({
      pluginAppPolicyContext: {
        fingerprint: "policy-2",
        apps: { app: pluginEntry({ destructiveApprovalMode: "ask", appId: "not-allowed" }) },
        pluginAppIds: {},
        mcpServers: {},
        nativePlugins: {},
      },
    });

    expect(invalid?.binding.pluginAppPolicyContext).toBeUndefined();
  });

  it("preserves version 2 ask approval mode and rejects invalid native ownership", () => {
    const policyContext = {
      fingerprint: "policy-2",
      apps: { app: pluginEntry({ destructiveApprovalMode: "ask" }) },
      pluginAppIds: {},
      nativePlugins: {
        "native/plugin": pluginEntry({ mcpServerNames: ["github"] }),
      },
      mcpServers: { github: "native/plugin", shared: null },
    };
    const stored = importBinding({ pluginAppPolicyContext: policyContext });
    const { mcpServers: _missingMcpOwners, ...oldPolicyContext } = policyContext;
    const oldBinding = readCodexAppServerThreadBinding({
      threadId: "thread-old-policy",
      cwd: "/repo",
      pluginAppPolicyContext: oldPolicyContext,
    });
    const invalid = importBinding({
      pluginAppPolicyContext: {
        ...policyContext,
        mcpServers: { github: "native/unknown" },
      },
    });

    expect(stored?.binding.pluginAppPolicyContext).toMatchObject(policyContext);
    expect(oldBinding?.pluginAppPolicyContext).toBeUndefined();
    expect(invalid?.binding.pluginAppPolicyContext).toBeUndefined();
  });

  it("round-trips repository marketplace app ownership through stored and imported bindings", async () => {
    const state = createCodexTestBindingStateStore(new Map());
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-security-review",
    };
    const owner = {
      configKey: "security-review@company-tools",
      marketplaceName: "company-tools",
      pluginName: "security-review",
      allowDestructiveActions: true,
      destructiveApprovalMode: "ask" as const,
      mcpServerNames: ["github"],
    };
    const pluginAppPolicyContext = {
      fingerprint: "repository-plugin-policy",
      apps: { github: owner },
      pluginAppIds: { "security-review@company-tools": ["github"] },
      mcpServers: { github: "native/security-review" },
      nativePlugins: { "native/security-review": owner },
    };

    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-security-review", cwd: "/repo/company", pluginAppPolicyContext },
    });
    expect(store.read(identity)).toMatchObject({ pluginAppPolicyContext });

    const imported = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-security-review",
      cwd: "/repo/company",
      pluginAppPolicyContext,
    });
    expect(imported?.binding.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("round-trips workspace-directory plugin policy context", () => {
    const stored = importBinding({
      pluginAppPolicyContext: {
        fingerprint: "policy-workspace",
        apps: {
          workspaceData: pluginEntry({
            configKey: "workspaceData",
            marketplaceName: "workspace-directory",
            pluginName: "workspace-data@workspace-directory",
            destructiveApprovalMode: "ask",
          }),
        },
        pluginAppIds: { workspaceData: ["workspace-data"] },
        mcpServers: {},
        nativePlugins: {},
      },
    });

    expect(stored?.binding.pluginAppPolicyContext).toMatchObject({
      apps: {
        workspaceData: {
          marketplaceName: "workspace-directory",
          pluginName: "workspace-data@workspace-directory",
          destructiveApprovalMode: "ask",
        },
      },
      pluginAppIds: { workspaceData: ["workspace-data"] },
    });
  });
});
