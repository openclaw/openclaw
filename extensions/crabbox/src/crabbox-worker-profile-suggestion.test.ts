import { describe, expect, it, vi } from "vitest";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import { createCrabboxProfileSuggestionDiscovery } from "./crabbox-worker-profile-suggestion.js";
import { parseCrabboxProfile } from "./crabbox-worker-profile.js";

const coordinatorConfig = {
  provider: "aws",
  providerSelected: true,
  coordinator: "https://coordinator.example.test",
  brokerAuth: "configured",
};
const classCatalog = {
  disposition: "mapped",
  profiles: [
    { class: "standard", target: "linux", architecture: "amd64", primary: { vcpu: 8 } },
    { class: "tiny", target: "windows", architecture: "amd64", primary: { vcpu: 2 } },
    { class: "small", target: "linux", architecture: "amd64", primary: { vcpu: 4 } },
  ],
};
const catalog = [
  {
    provider: "aws",
    targets: ["linux", "windows"],
    classCatalog,
  },
];

function fixture(config: unknown = coordinatorConfig, providers: unknown = catalog) {
  const runCommand = vi.fn<CrabboxCommandRunner>(async (argv) => ({
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    stdout: JSON.stringify(argv[1] === "config" ? config : providers),
    stderr: "",
  }));
  const warn = vi.fn();
  const dependencies = { findBinary: () => "/fixture/crabbox", runCommand, warn };
  return {
    dependencies,
    runCommand,
    discover: createCrabboxProfileSuggestionDiscovery(dependencies),
  };
}

describe("Crabbox suggested cloud profile", () => {
  it("offers the smallest advertised Linux class with stable, valid saved settings", async () => {
    const { discover, dependencies } = fixture();
    const suggestion = await discover({});
    expect(suggestion).toEqual({
      id: "cloud",
      providerDisplayId: "aws",
      profile: {
        provider: "crabbox",
        install: "bundle",
        suspendAfter: "45m",
        settings: {
          provider: "aws",
          target: "linux",
          class: "small",
          ttl: "8h",
          idleTimeout: "45m",
          warmImage: true,
        },
      },
    });
    expect(parseCrabboxProfile(suggestion!.profile.settings!)).toMatchObject({
      provider: "aws",
      class: "small",
      target: "linux",
    });
    expect(await createCrabboxProfileSuggestionDiscovery(dependencies)({})).toEqual(suggestion);
  });

  it("accepts explicitly configured direct providers without claiming live readiness", async () => {
    const { discover } = fixture({
      provider: "aws",
      providerSelected: true,
      providerStatus: {
        providers: {
          aws: {
            configuration: { state: "explicit" },
            authentication: { status: "unchecked" },
            readiness: "unchecked",
          },
        },
      },
    });
    expect(await discover({})).toMatchObject({ id: "cloud", providerDisplayId: "aws" });
  });

  it.each([
    {},
    { ...coordinatorConfig, providerSelected: false },
    { ...coordinatorConfig, brokerAuth: "missing" },
    {
      provider: "aws",
      providerSelected: true,
      providerStatus: { providers: { aws: { configuration: { state: "defaults_only" } } } },
    },
  ])("does not offer an unconfigured CLI: %j", async (config) => {
    const { discover } = fixture(config);
    expect(await discover({})).toBeUndefined();
  });

  it("requires an advertised Linux class", async () => {
    const { discover } = fixture(coordinatorConfig, [
      { provider: "aws", targets: ["windows"], classCatalog },
    ]);
    expect(await discover({})).toBeUndefined();
  });

  it("caches failed discovery and refreshes only on explicit adoption", async () => {
    const { discover, runCommand, dependencies } = fixture();
    runCommand.mockRejectedValueOnce(new Error("CLI unavailable"));
    expect(await discover({})).toBeUndefined();
    expect(await discover({})).toBeUndefined();
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(dependencies.warn).toHaveBeenCalledWith(expect.stringContaining("CLI unavailable"));
    expect(await discover({ refresh: true })).toMatchObject({ id: "cloud" });
    expect(await discover({})).toMatchObject({ id: "cloud" });
    expect(runCommand).toHaveBeenCalledTimes(3);
  });

  it("does not install or execute a missing CLI", async () => {
    const { dependencies, runCommand } = fixture();
    const discover = createCrabboxProfileSuggestionDiscovery({
      ...dependencies,
      findBinary: () => undefined,
    });
    expect(await discover({})).toBeUndefined();
    expect(runCommand).not.toHaveBeenCalled();
  });
});
