import path from "node:path";
import { loadCronStore, saveCronStore } from "openclaw/plugin-sdk/cron-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { isJsonObject } from "./protocol.js";
import {
  captureScheduledCodexAppAuthority,
  readScheduledCodexAppManagedRequirementsFingerprint,
} from "./scheduled-app-authority.js";
import {
  createScheduledAppAuthority as authority,
  createScheduledAppPolicyContext as policyContext,
} from "./scheduled-app-authority.test-support.js";
import { assertCodexManagedRequirementsDoNotOverrideToolPolicy } from "./thread-requests.js";

const tempDirs = useSessionStoreTempDirs(afterEach, "scheduled-configured-authority-");

describe("configured scheduled Codex app authority", () => {
  it("captures configured app-server authority without a prepared ChatGPT account", async () => {
    const managedRequirements = {
      hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command" }] }] },
    };
    const request = vi.fn(async (method: string) => {
      if (method === "app/installed") {
        return { apps: [{ id: "calendar", enabled: true, callable: true }] };
      }
      if (method === "mcpServerStatus/list") {
        return {
          data: [
            {
              name: "codex_apps",
              tools: { list: { _meta: { connector_id: "calendar" } } },
            },
          ],
          nextCursor: null,
        };
      }
      if (method === "config/read") {
        return { config: {} };
      }
      if (method === "configRequirements/read") {
        return { requirements: managedRequirements };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const captured = await captureScheduledCodexAppAuthority({
      client: { request } as never,
      threadId: "thread-final",
      policyContext: policyContext(),
      auth: {
        kind: "configured-app-server",
        connectionFingerprint: "configured-connection",
      },
    });
    expect(captured).toEqual(
      authority({
        auth: {
          kind: "configured-app-server",
          connectionFingerprint: "configured-connection",
          managedRequirementsFingerprint:
            "a4d596f697d28ef14df72874a0d57d2c88e9a6b7111fead04fe9186446a304dd",
          managedRequirementsSemanticFingerprint: expect.stringMatching(
            /^codex-managed-requirements:v2:[a-f0-9]{64}$/,
          ),
        },
        apps: [
          {
            id: "calendar",
            allowDestructiveActions: true,
            allowOpenWorld: true,
            destructiveApprovalMode: "allow",
            tools: { list: "approve" },
          },
        ],
      }),
    );
    assert(captured && isJsonObject(captured.payload) && isJsonObject(captured.payload.auth));
    // The released writer stores only the raw field. Exercise that envelope
    // alongside a new capture through the real SQLite cron persistence owner.
    const legacy = {
      ...captured,
      payload: {
        ...captured.payload,
        auth: {
          kind: "configured-app-server",
          connectionFingerprint: "configured-connection",
          managedRequirementsFingerprint:
            "a4d596f697d28ef14df72874a0d57d2c88e9a6b7111fead04fe9186446a304dd",
        },
      },
    };
    const storePath = path.join(tempDirs.make(), "cron", "jobs.json");
    await saveCronStore(storePath, {
      version: 1,
      jobs: [legacy, captured].map((runtimeAuthority, index) => ({
        id: `persisted-grant-${index}`,
        name: "Configured scheduled app",
        enabled: false,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "Read calendar", toolsAllow: ["list"] },
        scheduledToolPolicy: { version: 1, mode: "trusted" },
        runtimeAuthority,
        state: {},
      })),
    });
    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs.map((job) => job.enabled)).toEqual([false, false]);
    expect(loaded.jobs.map((job) => job.runtimeAuthority)).toEqual([legacy, captured]);
    expect(loaded.jobs.every((job) => !job.runtimeAuthorityRecoveryRequired)).toBe(true);
    const restoredLegacy = loaded.jobs[0]?.runtimeAuthority;
    expect(readScheduledCodexAppManagedRequirementsFingerprint(restoredLegacy)).toBe(
      legacy.payload.auth.managedRequirementsFingerprint,
    );
    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        restrictedToolSurface: true,
        allowedManagedRequirementsFingerprint:
          readScheduledCodexAppManagedRequirementsFingerprint(restoredLegacy),
      }),
    ).resolves.toEqual({ enableManagedHooks: true });

    // Validate the loaded new grant against the newer native representation.
    const persisted = JSON.stringify(captured);
    const restored = loaded.jobs[1]?.runtimeAuthority;
    assert(restored && isJsonObject(restored.payload) && isJsonObject(restored.payload.auth));
    assert(typeof restored.payload.auth.managedRequirementsFingerprint === "string");
    const allowed = readScheduledCodexAppManagedRequirementsFingerprint(restored);
    expect(allowed).toMatch(/^codex-managed-requirements:v2:/);
    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy(
        {
          request: vi.fn(async () => ({
            requirements: {
              ...managedRequirements,
              modelProvider: null,
              modelProviders: null,
              allowedLoginMethods: ["api", "chatgpt"],
              application: null,
            },
          })),
        } as never,
        { restrictedToolSurface: true, allowedManagedRequirementsFingerprint: allowed },
      ),
    ).resolves.toEqual({ enableManagedHooks: true });
    expect(JSON.stringify(restored)).toBe(persisted);

    // Pre-change Gateway readers select only the raw field. Keeping it byte-
    // compatible lets those readers validate the unchanged native runtime.
    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        restrictedToolSurface: true,
        allowedManagedRequirementsFingerprint: restored.payload.auth.managedRequirementsFingerprint,
      }),
    ).resolves.toEqual({ enableManagedHooks: true });
    expect(
      request.mock.calls.filter(([method]) => method === "configRequirements/read"),
    ).toHaveLength(3);
  });

  it.each([null, "", "codex-managed-requirements:v3:" + "a".repeat(64), 2])(
    "does not downgrade an unsupported semantic identity to a valid legacy hash: %j",
    (semantic) => {
      const saved = authority({
        auth: {
          kind: "configured-app-server",
          connectionFingerprint: "configured-connection",
          managedRequirementsFingerprint:
            "a4d596f697d28ef14df72874a0d57d2c88e9a6b7111fead04fe9186446a304dd",
          managedRequirementsSemanticFingerprint: semantic,
        },
      });
      expect(() => readScheduledCodexAppManagedRequirementsFingerprint(saved)).toThrow(
        "Unsupported Codex managed requirements identity",
      );
    },
  );

  it("does not fall back to the matching raw hash when a semantic grant disagrees", async () => {
    const saved = authority({
      auth: {
        kind: "configured-app-server",
        connectionFingerprint: "configured-connection",
        managedRequirementsFingerprint:
          "a4d596f697d28ef14df72874a0d57d2c88e9a6b7111fead04fe9186446a304dd",
        managedRequirementsSemanticFingerprint: "codex-managed-requirements:v2:" + "a".repeat(64),
      },
    });
    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy(
        {
          request: vi.fn(async () => ({
            requirements: {
              hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command" }] }] },
            },
          })),
        } as never,
        {
          restrictedToolSurface: true,
          allowedManagedRequirementsFingerprint:
            readScheduledCodexAppManagedRequirementsFingerprint(saved),
        },
      ),
    ).rejects.toThrow("managed requirements changed");
  });
});
