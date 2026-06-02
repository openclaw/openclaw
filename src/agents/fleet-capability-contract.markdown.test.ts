import { describe, expect, it } from "vitest";
import { buildFleetCapabilityContract } from "./fleet-capability-contract.js";
import { renderFleetCapabilityMarkdown } from "./fleet-capability-contract.markdown.js";

function sampleContract() {
  return buildFleetCapabilityContract({
    now: "2026-05-31T00:00:00.000Z",
    profiles: [
      {
        agentId: "peewee",
        name: "Pee-Wee",
        isDefault: true,
        configPresent: true,
        model: "anthropic/claude-opus-4-7",
        provider: "anthropic",
        providerCredentialsPresent: false,
        delegationConfigured: false,
        toolsConfigured: true,
        toolKeys: ["Read", "Write"],
      },
    ],
    services: {
      gatewayConfigured: false,
      stateDbPresent: true,
      cronStorePresent: true,
      githubCliPresent: true,
      githubAuthPresent: false,
      linearAuthPresent: false,
      deliveryBridgePresent: false,
    },
  });
}

describe("renderFleetCapabilityMarkdown", () => {
  it("renders headings, rollup, and tables", () => {
    const md = renderFleetCapabilityMarkdown(sampleContract());
    expect(md).toContain("# Fleet Capability Contract v1");
    expect(md).toContain("## Fleet services");
    expect(md).toContain("## Profiles");
    expect(md).toContain("peewee (Pee-Wee)");
    expect(md).toContain("| Status | Capability | Reason | Detail |");
    expect(md).toContain("`provider_credentials_missing`");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("escapes pipes in detail text so the table stays valid", () => {
    const contract = buildFleetCapabilityContract({
      now: "2026-05-31T00:00:00.000Z",
      profiles: [],
      services: {
        gatewayConfigured: true,
        stateDbPresent: true,
        cronStorePresent: true,
        githubCliPresent: true,
        githubAuthPresent: true,
        linearAuthPresent: true,
        deliveryBridgePresent: true,
      },
    });
    contract.services[0] = {
      ...contract.services[0],
      detail: "left | right",
    };
    const md = renderFleetCapabilityMarkdown(contract);
    expect(md).toContain("left \\| right");
  });

  it("notes when no profiles are configured", () => {
    const contract = buildFleetCapabilityContract({
      now: "2026-05-31T00:00:00.000Z",
      profiles: [],
      services: {
        gatewayConfigured: true,
        stateDbPresent: true,
        cronStorePresent: true,
        githubCliPresent: true,
        githubAuthPresent: true,
        linearAuthPresent: true,
        deliveryBridgePresent: true,
      },
    });
    const md = renderFleetCapabilityMarkdown(contract);
    expect(md).toContain("_No agent profiles configured._");
  });
});
