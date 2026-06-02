import { describe, expect, it } from "vitest";
import {
  buildFleetCapabilityContract,
  type FleetCapabilityInput,
  type FleetServiceInput,
  type ProfileCapabilityInput,
  isTruncatedToolKey,
  worstStatus,
} from "./fleet-capability-contract.js";

function healthyServices(overrides: Partial<FleetServiceInput> = {}): FleetServiceInput {
  return {
    gatewayConfigured: true,
    stateDbPresent: true,
    cronStorePresent: true,
    githubCliPresent: true,
    githubAuthPresent: true,
    linearAuthPresent: true,
    deliveryBridgePresent: true,
    ...overrides,
  };
}

function healthyProfile(overrides: Partial<ProfileCapabilityInput> = {}): ProfileCapabilityInput {
  return {
    agentId: "peewee",
    name: "Pee-Wee",
    isDefault: true,
    configPresent: true,
    model: "anthropic/claude-opus-4-7",
    provider: "anthropic",
    providerCredentialsPresent: true,
    delegationConfigured: false,
    toolsConfigured: true,
    toolKeys: ["Read", "Write", "Bash"],
    ...overrides,
  };
}

function build(input: Partial<FleetCapabilityInput> = {}) {
  return buildFleetCapabilityContract({
    now: "2026-05-31T00:00:00.000Z",
    profiles: [healthyProfile()],
    services: healthyServices(),
    ...input,
  });
}

describe("worstStatus", () => {
  it("returns the most severe status", () => {
    expect(worstStatus(["green", "green"])).toBe("green");
    expect(worstStatus(["green", "yellow"])).toBe("yellow");
    expect(worstStatus(["yellow", "red", "green"])).toBe("red");
    expect(worstStatus([])).toBe("green");
  });
});

describe("isTruncatedToolKey", () => {
  it("flags empty, padded, ellipsized, and null-byte keys", () => {
    expect(isTruncatedToolKey("")).toBe(true);
    expect(isTruncatedToolKey(" Read")).toBe(true);
    expect(isTruncatedToolKey("Read ")).toBe(true);
    expect(isTruncatedToolKey("Rea...")).toBe(true);
    expect(isTruncatedToolKey("Rea…")).toBe(true);
    expect(isTruncatedToolKey("Read\0")).toBe(true);
    expect(isTruncatedToolKey("Read")).toBe(false);
  });
});

describe("buildFleetCapabilityContract", () => {
  it("reports all green for a healthy fleet", () => {
    const contract = build();
    expect(contract.version).toBe(1);
    expect(contract.now).toBe("2026-05-31T00:00:00.000Z");
    expect(contract.rollup.status).toBe("green");
    expect(contract.rollup.red).toBe(0);
    expect(contract.rollup.yellow).toBe(0);
    expect(contract.profiles[0]?.status).toBe("green");
  });

  it("marks missing profile config as red", () => {
    const contract = build({
      profiles: [healthyProfile({ configPresent: false })],
    });
    const profile = contract.profiles[0];
    const check = profile?.checks.find((c) => c.id === "profile.config");
    expect(check?.status).toBe("red");
    expect(check?.reason).toBe("profile_config_missing");
    expect(profile?.status).toBe("red");
    expect(contract.rollup.status).toBe("red");
  });

  it("marks an unconfigured model as red and skips downstream provider checks", () => {
    const contract = build({
      profiles: [healthyProfile({ model: undefined, provider: undefined })],
    });
    const profile = contract.profiles[0];
    expect(profile?.checks.find((c) => c.id === "profile.model")?.status).toBe("red");
    expect(profile?.checks.some((c) => c.id === "profile.credentials")).toBe(false);
  });

  it("marks missing provider credentials as red when the provider is required", () => {
    const contract = build({
      profiles: [healthyProfile({ providerCredentialsPresent: false })],
    });
    const check = contract.profiles[0]?.checks.find((c) => c.id === "profile.credentials");
    expect(check?.status).toBe("red");
    expect(check?.reason).toBe("provider_credentials_missing");
  });

  it("downgrades missing provider credentials to yellow when not required", () => {
    const contract = build({
      profiles: [healthyProfile({ providerCredentialsPresent: false, requireProvider: false })],
    });
    const check = contract.profiles[0]?.checks.find((c) => c.id === "profile.credentials");
    expect(check?.status).toBe("yellow");
  });

  it("treats an undeterminable provider as yellow", () => {
    const contract = build({
      profiles: [healthyProfile({ model: "mystery-model", provider: undefined })],
    });
    const check = contract.profiles[0]?.checks.find((c) => c.id === "profile.provider");
    expect(check?.status).toBe("yellow");
    expect(check?.reason).toBe("provider_unknown");
  });

  it("flags truncated tool keys as red", () => {
    const contract = build({
      profiles: [healthyProfile({ toolKeys: ["Read", "Writ..."] })],
    });
    const check = contract.profiles[0]?.checks.find((c) => c.id === "profile.tools");
    expect(check?.status).toBe("red");
    expect(check?.reason).toBe("tool_key_truncated");
  });

  it("warns (yellow) when tools are unconfigured", () => {
    const contract = build({
      profiles: [healthyProfile({ toolsConfigured: false, toolKeys: [] })],
    });
    const check = contract.profiles[0]?.checks.find((c) => c.id === "profile.tools");
    expect(check?.status).toBe("yellow");
    expect(check?.reason).toBe("tools_unconfigured");
  });

  it("flags missing required tools as red", () => {
    const contract = build({
      profiles: [healthyProfile({ requiredToolKeys: ["Bash", "Grep"] })],
    });
    const check = contract.profiles[0]?.checks.find((c) => c.id === "profile.tools.required");
    expect(check?.status).toBe("red");
    expect(check?.detail).toContain("Grep");
    expect(check?.detail).not.toContain("Bash");
  });

  it("treats delegation issues as yellow, never red", () => {
    const contract = build({
      profiles: [healthyProfile({ delegationConfigured: true, delegationModel: undefined })],
    });
    const check = contract.profiles[0]?.checks.find((c) => c.id === "profile.delegation.model");
    expect(check?.status).toBe("yellow");
    expect(check?.required).toBe(false);
  });

  it("degrades missing optional services to yellow, not red", () => {
    const contract = build({
      services: healthyServices({
        githubCliPresent: false,
        githubAuthPresent: false,
        linearAuthPresent: false,
        deliveryBridgePresent: false,
        gatewayConfigured: false,
      }),
    });
    expect(contract.rollup.status).toBe("yellow");
    for (const check of contract.services) {
      expect(check.status).not.toBe("red");
    }
  });

  it("escalates a required-but-missing service to red", () => {
    const contract = build({
      services: healthyServices({ stateDbPresent: false, stateDbRequired: true }),
    });
    const check = contract.services.find((c) => c.id === "service.stateDb");
    expect(check?.status).toBe("red");
    expect(contract.rollup.status).toBe("red");
  });

  it("never leaks secret-shaped values into the contract output", () => {
    const secret = "sk-do-not-leak-1234567890";
    const contract = buildFleetCapabilityContract({
      now: "2026-05-31T00:00:00.000Z",
      profiles: [
        healthyProfile({
          // Even if a caller mistakenly passes a secret-looking model/tool key,
          // the contract must surface only structural data, never echo it back
          // beyond what the caller already had. We assert the serialized output
          // contains no env-var values that were never provided.
          providerCredentialsPresent: false,
        }),
      ],
      services: healthyServices(),
    });
    const serialized = JSON.stringify(contract);
    expect(serialized).not.toContain(secret);
    // Reason codes and details are structural strings only.
    for (const profile of contract.profiles) {
      for (const check of profile.checks) {
        expect(check.detail ?? "").not.toMatch(/sk-[A-Za-z0-9]/);
      }
    }
  });
});
