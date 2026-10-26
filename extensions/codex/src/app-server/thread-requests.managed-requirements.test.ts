import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "./protocol.js";
import {
  assertCodexManagedRequirementsDoNotOverrideToolPolicy,
  readCodexManagedRequirementsIdentity,
} from "./thread-requests.js";

const managedRequirements = {
  hooks: {
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "managed-hook" }] }],
  },
  featureRequirements: { hooks: true },
};

// Protocol fixtures for the same policy before and after Codex 0.153 -> 0.163.
const legacyRequirements = { ...managedRequirements, windowsSandboxPrivateDesktop: null };
const upgradedRequirements = {
  ...managedRequirements,
  modelProvider: null,
  modelProviders: null,
  application: null,
  allowedLoginMethods: ["api", "chatgpt"],
};
// Frozen original SHA-256 of {version:1, requirements:legacyRequirements}, with sorted keys.
const legacyFingerprint = "4109571b7ed957c793c78041522bd387216cbaa4835452f4c29af95fdd100fa0";

async function capture(requirements: JsonObject | null) {
  return readCodexManagedRequirementsIdentity({
    request: vi.fn(async () => ({ requirements })),
  } as never);
}

async function admit(requirements: JsonObject | null, fingerprint: string) {
  return assertCodexManagedRequirementsDoNotOverrideToolPolicy(
    { request: vi.fn(async () => ({ requirements })) } as never,
    { restrictedToolSurface: true, allowedManagedRequirementsFingerprint: fingerprint },
  );
}

describe("configured app-server managed requirements", () => {
  it("preserves legacy JSON ordering for numeric requirement keys", async () => {
    const futurePolicy = { "10": true, "2": false };
    const saved = "d3713ffd3e1a8702ef643ba2974a9cb44934d3f70772988af9165b4ecdf9f074";
    expect(
      (await capture({ ...legacyRequirements, futurePolicy })).managedRequirementsFingerprint,
    ).toBe(saved);
    await expect(admit({ ...upgradedRequirements, futurePolicy }, saved)).resolves.toEqual({
      enableManagedHooks: true,
    });
  });

  it("keeps an existing scheduled grant valid across a representation-only runtime upgrade", async () => {
    expect((await capture(legacyRequirements)).managedRequirementsFingerprint).toBe(
      legacyFingerprint,
    );
    await expect(admit(upgradedRequirements, legacyFingerprint)).resolves.toEqual({
      enableManagedHooks: true,
    });
  });

  it.each(["managedRequirementsFingerprint", "managedRequirementsSemanticFingerprint"] as const)(
    "preserves %s across a native runtime upgrade and rollback, including browser defaults",
    async (field) => {
      const browserUse = { allowHistoryAccess: false, defaultOriginPolicy: null };
      const before = { ...legacyRequirements, browserUse };
      const after = {
        ...upgradedRequirements,
        browserUse: { ...browserUse, extension: null, allowWebmcp: null },
      };
      const savedBefore = (await capture(before))[field];
      const savedAfter = (await capture(after))[field];
      for (const requirements of [after, before]) {
        for (const fingerprint of [savedBefore, savedAfter]) {
          await expect(admit(requirements, fingerprint)).resolves.toEqual({
            enableManagedHooks: true,
          });
        }
      }
    },
  );

  it.each([
    ["hooks", { hooks: {} }],
    ["network", { network: { allowedDomains: ["example.test"] } }],
    ["approval", { allowedApprovalPolicies: ["never"] }],
    ["provider", { modelProvider: "other" }],
    ["provider definition", { modelProviders: { other: { base_url: "https://example.test" } } }],
    ["application", { application: { network: { enabled: false } } }],
    ["login restriction", { allowedLoginMethods: ["chatgpt"] }],
    ["login denial", { allowedLoginMethods: [] }],
    ["unknown login state", { allowedLoginMethods: null }],
    ["future login method", { allowedLoginMethods: ["api", "chatgpt", "other"] }],
    ["removed Windows constraint", { windowsSandboxPrivateDesktop: true }],
    ["unknown null requirement", { futurePolicy: null }],
    ["unknown false requirement", { futurePolicy: false }],
    ["prototype-named requirement", JSON.parse('{"__proto__":{"enabled":true}}')],
  ] satisfies Array<[string, JsonObject]>)(
    "rejects changed %s for both legacy and semantic grants",
    async (_name, patch) => {
      const semantic = (await capture(legacyRequirements)).managedRequirementsSemanticFingerprint;
      for (const fingerprint of [legacyFingerprint, semantic]) {
        await expect(admit({ ...upgradedRequirements, ...patch }, fingerprint)).rejects.toThrow(
          "managed requirements changed",
        );
      }
    },
  );

  const browserChanges: JsonObject[] = [
    { extension: { requestHeaders: [] } },
    { allowWebmcp: false },
    { futureBrowserPolicy: null },
  ];
  it.each(browserChanges)(
    "retains non-default and unknown nested browser requirements: %j",
    async (patch) => {
      const before = { ...legacyRequirements, browserUse: { allowHistoryAccess: false } };
      const saved = await capture(before);
      for (const fingerprint of [
        saved.managedRequirementsFingerprint,
        saved.managedRequirementsSemanticFingerprint,
      ]) {
        await expect(
          admit(
            { ...upgradedRequirements, browserUse: { allowHistoryAccess: false, ...patch } },
            fingerprint,
          ),
        ).rejects.toThrow("managed requirements changed");
      }
    },
  );

  it("does not forget a non-default requirement when a runtime rollback stops reporting it", async () => {
    const saved = await capture({ ...upgradedRequirements, allowedLoginMethods: ["chatgpt"] });
    for (const fingerprint of [
      saved.managedRequirementsFingerprint,
      saved.managedRequirementsSemanticFingerprint,
    ]) {
      await expect(admit(legacyRequirements, fingerprint)).rejects.toThrow(
        "managed requirements changed",
      );
    }
  });

  it("keeps null requirements distinct from an object and does not ignore unknown fingerprint versions", async () => {
    const saved = await capture(null);
    await expect(admit(null, saved.managedRequirementsSemanticFingerprint)).resolves.toEqual({
      enableManagedHooks: false,
    });
    await expect(admit({}, saved.managedRequirementsSemanticFingerprint)).rejects.toThrow(
      "managed requirements changed",
    );
    await expect(
      admit(null, saved.managedRequirementsSemanticFingerprint.replace(":v2:", ":v3:")),
    ).rejects.toThrow("managed requirements changed");
  });

  it("admits managed hooks for an interactive plugin-policy turn", async () => {
    const request = vi.fn(async () => ({ requirements: managedRequirements }));

    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        restrictedToolSurface: true,
        allowConfiguredManagedHooks: true,
      }),
    ).resolves.toEqual({ enableManagedHooks: true });
  });

  it("admits the exact managed requirements captured for a scheduled restricted turn", async () => {
    const request = vi.fn(async () => ({ requirements: managedRequirements }));
    const { managedRequirementsFingerprint } = await readCodexManagedRequirementsIdentity({
      request,
    } as never);

    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        restrictedToolSurface: true,
        allowedManagedRequirementsFingerprint: managedRequirementsFingerprint,
      }),
    ).resolves.toEqual({ enableManagedHooks: true });
  });

  it("fails closed when managed requirements change after scheduled authorization", async () => {
    const request = vi.fn(async () => ({ requirements: managedRequirements }));
    const { managedRequirementsFingerprint: allowedManagedRequirementsFingerprint } =
      await readCodexManagedRequirementsIdentity({
        request: vi.fn(async () => ({ requirements: { hooks: {} } })),
      } as never);

    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        restrictedToolSurface: true,
        allowedManagedRequirementsFingerprint,
      }),
    ).rejects.toThrow("managed requirements changed");
  });

  it("keeps an explicit managed disable above the attested hook inventory", async () => {
    const request = vi.fn(async () => ({
      requirements: { ...managedRequirements, featureRequirements: { hooks: false } },
    }));
    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        restrictedToolSurface: true,
        allowConfiguredManagedHooks: true,
        privateManagedHooksPresent: true,
      }),
    ).resolves.toEqual({ enableManagedHooks: false });
  });
});
