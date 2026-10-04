import { describe, expect, it, vi } from "vitest";
import { assertCodexManagedRequirementsDoNotOverrideToolPolicy } from "./thread-requests.js";

const managedRequirements = {
  hooks: {
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "managed-hook" }] }],
  },
  featureRequirements: { hooks: true },
};

describe("configured app-server managed requirements", () => {
  it("admits managed hooks for an interactive plugin-policy turn", async () => {
    const request = vi.fn(async () => ({ requirements: managedRequirements }));

    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        restrictedToolSurface: true,
        allowConfiguredManagedHooks: true,
      }),
    ).resolves.toEqual({ enableManagedHooks: true });
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
