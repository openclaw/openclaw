import { describe, expect, it } from "vitest";
import {
  buildCrabboxAllocationArgs,
  parseCrabboxProfile,
  resolveCrabboxWarmImageProfileKey,
} from "./crabbox-worker-profile.js";

const BASE = { provider: "azure", ttl: "1h", idleTimeout: "15m", class: "standard" };
const RESOURCE =
  "/subscriptions/00000000-0000-4000-8000-000000000000/resourceGroups/synthetic-workers/providers/Microsoft.ManagedIdentity/userAssignedIdentities/synthetic-worker-llm";

describe("Crabbox worker Azure identity", () => {
  it("binds allocation and prepared capacity to the exact UAMI", () => {
    const profile = parseCrabboxProfile({ ...BASE, azureUserAssignedIdentityResourceId: RESOURCE });
    const args = buildCrabboxAllocationArgs(profile, "worker-lease", "worker");
    expect(
      args.slice(
        args.indexOf("--azure-user-assigned-identity-resource-id"),
        args.indexOf("--azure-user-assigned-identity-resource-id") + 2,
      ),
    ).toEqual(["--azure-user-assigned-identity-resource-id", RESOURCE]);
    expect(resolveCrabboxWarmImageProfileKey(profile)).not.toBe(
      resolveCrabboxWarmImageProfileKey(parseCrabboxProfile(BASE)),
    );
  });

  it("rejects identity attachment outside Azure", () => {
    expect(() =>
      parseCrabboxProfile({
        ...BASE,
        provider: "aws",
        azureUserAssignedIdentityResourceId: RESOURCE,
      }),
    ).toThrow();
  });
});
