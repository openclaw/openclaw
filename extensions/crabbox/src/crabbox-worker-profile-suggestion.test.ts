import { afterEach, expect, it, vi } from "vitest";
import * as binaryDiscovery from "./crabbox-binary.js";
import * as processRunner from "./crabbox-process.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import { createCrabboxProfileSuggestionDiscovery } from "./crabbox-worker-profile-suggestion.js";
import { parseCrabboxProfile } from "./crabbox-worker-profile.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";

afterEach(() => vi.restoreAllMocks());

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
const catalog = [{ provider: "aws", targets: ["linux", "windows"], classCatalog }];
function directConfig(state: string) {
  const aws = {
    configuration: { state },
    authentication: { status: "unchecked" },
    readiness: "unchecked",
  };
  return { provider: "aws", providerSelected: true, providerStatus: { providers: { aws } } };
}

function fixture(config: unknown = coordinatorConfig, providers: unknown = catalog) {
  const runCommand = vi.fn<CrabboxCommandRunner>(async (argv) =>
    commandResult({
      stdout: JSON.stringify(argv[1] === "config" ? config : providers),
    }),
  );
  const warn = vi.fn();
  vi.spyOn(binaryDiscovery, "findCrabboxBinary").mockReturnValue("/fixture/crabbox");
  vi.spyOn(processRunner, "runCrabboxProcess").mockImplementation(runCommand);
  const dependencies = { warn };
  return {
    dependencies,
    runCommand,
    discover: createCrabboxProfileSuggestionDiscovery(dependencies),
  };
}

it("offers the smallest advertised Linux class with stable, valid saved settings", async () => {
  const { discover, dependencies } = fixture();
  const suggestion = await discover({});
  const machine = { provider: "aws", class: "small", target: "linux" };
  expect(suggestion).toEqual({
    id: "cloud",
    providerDisplayId: "aws",
    profile: {
      provider: "crabbox",
      install: "bundle",
      suspendAfter: "45m",
      settings: {
        ...machine,
        ttl: "4h",
        idleTimeout: "45m",
        warmImage: true,
      },
    },
  });
  expect(parseCrabboxProfile(suggestion!.profile.settings!)).toMatchObject(machine);
  expect(await createCrabboxProfileSuggestionDiscovery(dependencies)({})).toEqual(suggestion);
});

it.each([
  [directConfig("explicit"), { id: "cloud", providerDisplayId: "aws" }],
  [{}, undefined],
  [{ ...coordinatorConfig, providerSelected: false }, undefined],
  [{ ...coordinatorConfig, brokerAuth: "missing" }, undefined],
  [directConfig("defaults_only"), undefined],
])("offers only explicitly configured providers: %j", async (config, expected) => {
  const { discover } = fixture(config);
  if (expected) {
    expect(await discover({})).toMatchObject(expected);
  } else {
    expect(await discover({})).toBeUndefined();
  }
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
  vi.spyOn(binaryDiscovery, "findCrabboxBinary").mockReturnValue(undefined);
  const discover = createCrabboxProfileSuggestionDiscovery(dependencies);
  expect(await discover({})).toBeUndefined();
  expect(runCommand).not.toHaveBeenCalled();
});
