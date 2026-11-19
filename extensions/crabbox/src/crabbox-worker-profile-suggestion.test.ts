import { afterEach, expect, it, vi } from "vitest";
import * as binaryDiscovery from "./crabbox-binary.js";
import * as processRunner from "./crabbox-process.js";
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
const profiles = [
  { class: "standard", target: "linux", architecture: "amd64", primary: { vcpu: 8 } },
  { class: "tiny", target: "windows", architecture: "amd64", primary: { vcpu: 2 } },
  { class: "small", target: "linux", architecture: "amd64", primary: { vcpu: 4 } },
];
function directConfig(state: string) {
  const aws = { configuration: { state } };
  return { provider: "aws", providerSelected: true, providerStatus: { providers: { aws } } };
}

function fixture(config: unknown = coordinatorConfig, targets = ["linux", "windows"]) {
  const catalog = [{ provider: "aws", targets, classCatalog: { disposition: "mapped", profiles } }];
  const runCommand = vi.spyOn(processRunner, "runCrabboxProcess");
  runCommand.mockImplementation(async (argv) =>
    commandResult({ stdout: JSON.stringify(argv[1] === "config" ? config : catalog) }),
  );
  const warn = vi.fn();
  vi.spyOn(binaryDiscovery, "findCrabboxBinary").mockReturnValue(
    config === null ? undefined : "/fixture/crabbox",
  );
  const discover = createCrabboxProfileSuggestionDiscovery({ warn });
  return { discover, runCommand, warn };
}

it.each([coordinatorConfig, directConfig("explicit")])("suggests Linux: %j", async (config) => {
  const { discover } = fixture(config);
  const suggestion = await discover({});
  const machine = { provider: "aws", class: "small", target: "linux" };
  expect(suggestion).toEqual({
    id: "cloud",
    providerDisplayId: "aws",
    profile: {
      provider: "crabbox",
      install: "bundle",
      suspendAfter: "45m",
      settings: { ...machine, ttl: "4h", idleTimeout: "45m", warmImage: true },
    },
  });
  expect(parseCrabboxProfile(suggestion!.profile.settings!)).toMatchObject(machine);
});

it.each([
  [null, []], // Missing CLI: reject before executing any command.
  [{ ...coordinatorConfig, providerSelected: false }, ["linux"]],
  [{ ...coordinatorConfig, brokerAuth: "missing" }, ["linux"]],
  [directConfig("defaults_only"), ["linux"]],
  [coordinatorConfig, ["windows"]],
])("rejects unusable configuration/catalog: %j %j", async (config, targets) => {
  const { discover, runCommand } = fixture(config, targets);
  expect(await discover({})).toBeUndefined();
  if (config === null) {
    expect(runCommand).not.toHaveBeenCalled();
  }
});

it("caches failed discovery and refreshes only on explicit adoption", async () => {
  const { discover, runCommand, warn } = fixture();
  runCommand.mockRejectedValueOnce(new Error("CLI unavailable"));
  expect(await discover({})).toBeUndefined();
  expect(await discover({})).toBeUndefined();
  expect(runCommand).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("CLI unavailable"));
  expect(await discover({ refresh: true })).toMatchObject({ id: "cloud" });
  expect(await discover({})).toMatchObject({ id: "cloud" });
  expect(runCommand).toHaveBeenCalledTimes(3);
});
