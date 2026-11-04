import { describe, expect, it } from "vitest";
import { crabboxState } from "./crabbox-state.test-support.js";
import {
  buildCrabboxAllocationArgs,
  parseCrabboxCleanupProfile,
  parseCrabboxProfile,
} from "./crabbox-worker-profile.js";
import { createCrabboxWorkerProvider } from "./crabbox-worker-provider.js";
import {
  crabboxResourceEnv,
  crabboxSupportedResources,
  parseCrabboxRequestedResources,
  selectCrabboxMachineResources,
} from "./crabbox-worker-resource-options.js";

const PROFILE = {
  provider: "aws",
  class: "standard",
  ttl: "24h",
  idleTimeout: "60m",
  warmImage: true,
};

describe("typed Crabbox machine resources", () => {
  it("selects native resources through the provider and persists them for cleanup", async () => {
    const provider = createCrabboxWorkerProvider({
      state: crabboxState,
      wallpaperPath: new URL("../assets/openclaw-worker-wallpaper.png", import.meta.url).pathname,
    });
    expect(provider.selectMachineResources).toBeTypeOf("function");
    const resources = { machineType: "m7i.large", region: "eu-west-2", diskSizeGb: 96 };
    const selected = provider.selectMachineResources!(PROFILE, resources);
    expect(selected).toEqual({ ...PROFILE, requestedResources: resources, warmImage: false });
    const parsed = parseCrabboxProfile(selected);
    expect(buildCrabboxAllocationArgs(parsed, "test-lease", "resource-test")).toEqual(
      expect.arrayContaining(["--type", "m7i.large"]),
    );
    expect(crabboxResourceEnv(parsed.provider, parsed.requestedResources)).toEqual({
      CRABBOX_AWS_REGION: "eu-west-2",
      CRABBOX_AWS_ROOT_GB: "96",
    });
    expect(parseCrabboxCleanupProfile(selected).requestedResources).toEqual(resources);
    expect(PROFILE).not.toHaveProperty("requestedResources");
    await provider.dispose();
  });

  it.each([
    [
      "azure",
      { machineType: "Standard_D4s_v5", osDiskMode: "managed", osDiskSku: "Premium_LRS" },
      [
        "--type",
        "Standard_D4s_v5",
        "--azure-os-disk",
        "managed",
        "--azure-os-disk-sku",
        "Premium_LRS",
      ],
      undefined,
    ],
    [
      "gcp",
      { machineType: "n2-standard-4", region: "us-central1-a", diskSizeGb: 80 },
      ["--type", "n2-standard-4"],
      { CRABBOX_GCP_ZONE: "us-central1-a", CRABBOX_GCP_ROOT_GB: "80" },
    ],
    [
      "machine0",
      { machineType: "large", region: "eu-west" },
      ["--machine0-size", "large", "--machine0-region", "eu-west"],
      { CRABBOX_MACHINE0_REGION: "eu-west" },
    ],
  ] as const)(
    "maps %s native resource knobs without substituting control-plane settings",
    (provider, resources, args, env) => {
      const profile = { ...PROFILE, provider, binary: "/admin/crabbox", setup: "admin-setup" };
      const selected = selectCrabboxMachineResources(profile, resources);
      const parsed = parseCrabboxProfile(selected);
      expect(buildCrabboxAllocationArgs(parsed, "test-lease", "resource-test")).toEqual(
        expect.arrayContaining([...args]),
      );
      expect(crabboxResourceEnv(provider, parsed.requestedResources)).toEqual(env);
      expect(selected).toMatchObject({
        provider,
        binary: "/admin/crabbox",
        setup: "admin-setup",
        class: "standard",
        warmImage: false,
      });
    },
  );

  it.each([
    ["daytona", { machineType: "large" }],
    ["azure", { region: "eastus" }],
    ["azure", { diskSizeGb: 128 }],
    ["machine0", { diskSizeGb: 128 }],
    ["aws", { osDiskMode: "ephemeral" }],
    ["hetzner", { machineType: "cpx31" }],
  ] as const)("rejects unsupported %s resource overrides", (provider, resources) => {
    expect(() => selectCrabboxMachineResources({ ...PROFILE, provider }, resources)).toThrow(
      /does not support independent resource override/,
    );
  });

  it.each([
    { provider: "azure" },
    { binary: "/bin/helper" },
    { image: "admin-image" },
    { endpoint: "https://other" },
    { env: { AWS_PROFILE: "other" } },
    { mounts: ["/etc"] },
    { flags: ["--profile=admin"] },
    { machineType: "--profile=admin" },
    { region: "a/b" },
    { diskSizeGb: 0 },
    { diskSizeGb: 1.5 },
    { diskSizeGb: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid or authority-bearing request %j", (resources) => {
    expect(() => parseCrabboxRequestedResources("aws", resources)).toThrow(
      /Invalid Crabbox machine resources/,
    );
  });

  it("reports backend-specific fields rather than administrator recipes", () => {
    expect(crabboxSupportedResources("gcp")).toEqual({
      fields: ["machineType", "region", "diskSizeGb"],
      regionKind: "zone",
    });
    expect(crabboxSupportedResources("daytona")).toEqual({
      fields: [],
      note: expect.stringContaining("snapshot-owned"),
    });
  });
});
