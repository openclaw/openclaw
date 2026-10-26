import { describe, expect, it, vi } from "vitest";
import {
  captureScheduledCodexAppAuthority,
  readScheduledCodexAppManagedRequirementsFingerprint,
} from "./scheduled-app-authority.js";
import {
  createScheduledAppAuthority as authority,
  createScheduledAppPolicyContext as policyContext,
} from "./scheduled-app-authority.test-support.js";
import { assertCodexManagedRequirementsDoNotOverrideToolPolicy } from "./thread-requests.js";

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
    // Reload the actual captured envelope through the production parser, then
    // validate the same policy using the newer native protocol representation.
    const persisted = JSON.stringify(captured);
    const restored = JSON.parse(persisted);
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
    ).toHaveLength(2);
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
