// Codex tests cover persisted binding codecs and SQLite serialization.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  createCodexAppServerBindingStore,
  createStoredCodexAppServerBinding,
  hashCodexAppServerBindingFingerprint,
  readCodexAppServerThreadBinding,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests();
});

describe("Codex app-server binding codec", () => {
  it("normalizes the retired approval policy in persisted bindings", () => {
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-legacy-policy",
        cwd: "/repo",
        approvalPolicy: "on-failure",
        sandbox: "workspace-write",
      }),
    ).toMatchObject({
      threadId: "thread-legacy-policy",
      cwd: "/repo",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  });

  it("preserves the effective managed approval policy in persisted thread bindings", () => {
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-untrusted-policy",
        cwd: "/repo",
        approvalPolicy: "untrusted",
        sandbox: "workspace-write",
      }),
    ).toEqual({
      threadId: "thread-untrusted-policy",
      cwd: "/repo",
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
    });
  });

  it("rejects unsafe marketplace names in imported plugin app ownership", () => {
    const imported = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-unsafe-plugin",
      cwd: "/repo/company",
      pluginAppPolicyContext: {
        fingerprint: "unsafe-plugin-policy",
        apps: {
          github: {
            configKey: "security-review",
            marketplaceName: "../unsafe-marketplace",
            pluginName: "security-review",
            allowDestructiveActions: true,
            mcpServerNames: ["github"],
          },
        },
        pluginAppIds: { "security-review": ["github"] },
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
    const imported = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-legacy-fingerprints",
      cwd: "/repo",
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
    const canonical = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-canonical-fingerprints",
      cwd: "/repo",
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
      const state = createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>("codex", {
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
        const imported = createStoredCodexAppServerBinding({
          schemaVersion: 2,
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
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("maps the legacy sidecar update timestamp to the history watermark", () => {
    const updatedAt = "2026-01-01T00:00:00.000Z";
    const stored = createStoredCodexAppServerBinding({
      schemaVersion: 1,
      threadId: "thread-1",
      cwd: "/repo",
      createdAt: "2025-12-31T00:00:00.000Z",
      updatedAt,
    });

    expect(stored?.binding).toMatchObject({ historyCoveredThrough: updatedAt });
    expect(stored?.binding).not.toHaveProperty("createdAt");
    expect(stored?.binding).not.toHaveProperty("updatedAt");
  });

  it("normalizes version 1 destructive approval modes during import", () => {
    const stored = createStoredCodexAppServerBinding({
      schemaVersion: 1,
      threadId: "thread-1",
      cwd: "/repo",
      pluginAppPolicyContext: {
        fingerprint: "policy-1",
        apps: {
          allow: {
            configKey: "allow",
            marketplaceName: "openai-curated",
            pluginName: "allow-plugin",
            allowDestructiveActions: true,
            destructiveApprovalMode: "auto",
            mcpServerNames: [],
          },
          prompt: {
            configKey: "prompt",
            marketplaceName: "openai-curated",
            pluginName: "prompt-plugin",
            allowDestructiveActions: true,
            destructiveApprovalMode: "on-request",
            mcpServerNames: [],
          },
        },
        pluginAppIds: {},
      },
    });

    expect(stored?.binding.pluginAppPolicyContext?.apps.allow?.destructiveApprovalMode).toBe(
      "allow",
    );
    expect(stored?.binding.pluginAppPolicyContext?.apps.prompt?.destructiveApprovalMode).toBe(
      "auto",
    );
  });

  it("preserves version 2 ask approval mode and drops invalid policy contexts", () => {
    const policyContext = {
      fingerprint: "policy-2",
      apps: {
        app: {
          configKey: "app",
          marketplaceName: "openai-curated",
          pluginName: "plugin",
          allowDestructiveActions: true,
          destructiveApprovalMode: "ask",
          mcpServerNames: [],
        },
      },
      pluginAppIds: {},
    };
    const stored = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-2",
      cwd: "/repo",
      pluginAppPolicyContext: policyContext,
    });
    const invalid = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-invalid",
      cwd: "/repo",
      pluginAppPolicyContext: {
        ...policyContext,
        apps: { app: { ...policyContext.apps.app, appId: "not-allowed" } },
      },
    });

    expect(stored?.binding.pluginAppPolicyContext?.apps.app?.destructiveApprovalMode).toBe("ask");
    expect(invalid?.binding.pluginAppPolicyContext).toBeUndefined();
  });

  it("round-trips workspace-directory plugin policy context", () => {
    const stored = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-workspace-plugin",
      cwd: "/repo",
      pluginAppPolicyContext: {
        fingerprint: "policy-workspace",
        apps: {
          workspaceData: {
            configKey: "workspaceData",
            marketplaceName: "workspace-directory",
            pluginName: "workspace-data@workspace-directory",
            allowDestructiveActions: true,
            destructiveApprovalMode: "ask",
            mcpServerNames: [],
          },
        },
        pluginAppIds: { workspaceData: ["workspace-data"] },
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
