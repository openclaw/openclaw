import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it } from "vitest";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  createCodexAppServerBindingStore,
  createStoredCodexAppServerBinding,
  hashCodexAppServerBindingFingerprint,
  readCodexAppServerThreadBinding,
} from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";

function importBinding(fields: Record<string, unknown>) {
  return createStoredCodexAppServerBinding({
    schemaVersion: 2,
    threadId: "thread-1",
    cwd: "/repo",
    ...fields,
  });
}

function importPolicy(
  fields: Record<string, unknown>,
  pluginAppIds: Record<string, string[]> = {},
) {
  return importBinding({
    pluginAppPolicyContext: {
      fingerprint: "policy",
      apps: { app: pluginEntry(fields) },
      pluginAppIds,
    },
  })?.binding.pluginAppPolicyContext;
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

describe("Codex app-server binding codec", () => {
  it("migrates the retired on-failure approval policy", () => {
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-policy",
        cwd: "/repo",
        approvalPolicy: "on-failure",
        sandbox: "workspace-write",
      }),
    ).toEqual({
      threadId: "thread-policy",
      cwd: "/repo",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  });

  it("rejects unsafe marketplace names in imported plugin app ownership", () => {
    expect(importPolicy({ marketplaceName: "../unsafe-marketplace" })).toBeUndefined();
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
          createdAt: "2025-12-31T00:00:00.000Z",
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

  it.each([
    { destructiveApprovalMode: "ask", appId: "not-allowed" },
    { destructiveApprovalMode: "on-request" },
  ])("drops invalid imported policy contexts: %j", (fields) => {
    expect(importPolicy(fields)).toBeUndefined();
  });

  it("round-trips workspace-directory plugin policy context", () => {
    const stored = importPolicy(
      {
        configKey: "workspaceData",
        marketplaceName: "workspace-directory",
        pluginName: "workspace-data@workspace-directory",
        destructiveApprovalMode: "ask",
      },
      { workspaceData: ["workspace-data"] },
    );

    expect(stored).toMatchObject({
      apps: {
        app: {
          marketplaceName: "workspace-directory",
          pluginName: "workspace-data@workspace-directory",
          destructiveApprovalMode: "ask",
        },
      },
      pluginAppIds: { workspaceData: ["workspace-data"] },
    });
  });
});
