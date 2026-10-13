import { afterEach, describe, expect, it, vi } from "vitest";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { loadLegacyPluginMetadataSnapshotRuntime } from "../../plugins/plugin-metadata-snapshot-required.js";
import { resolvePluginMetadataSnapshotAsync } from "../../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { sanitizeEnvVars, sanitizeEnvVarsAsync } from "./sanitize-env-vars.js";

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: vi.fn(),
}));
vi.mock("../../plugins/plugin-metadata-snapshot-required.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-metadata-snapshot-required.js")>()),
  loadLegacyPluginMetadataSnapshotRuntime: vi.fn(),
}));
vi.mock("../../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshotAsync: vi.fn(),
}));
vi.mock("../../plugins/sdk-deprecation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/sdk-deprecation.js")>()),
  warnPluginSdkDeprecation: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

function metadataWithBillingCredential(name: string) {
  return createPluginMetadataSnapshotFixture({
    plugins: [{ id: "sample", providerUsageAuthEnvVars: { sample: [name] } }],
  });
}

describe("sandbox credential metadata", () => {
  it("retains cold SDK credential filtering, including inactive provider hints", async () => {
    const metadata = metadataWithBillingCredential("PROVIDER_BILLING_CREDENTIAL");
    const index = structuredClone(metadata.index);
    for (const plugin of index.plugins) {
      plugin.enabled = false;
    }
    const snapshot = { ...metadata, index };
    vi.mocked(loadLegacyPluginMetadataSnapshotRuntime).mockReturnValue(snapshot);
    vi.mocked(resolvePluginMetadataSnapshotAsync).mockResolvedValue(snapshot);
    const inherited = { PROVIDER_BILLING_CREDENTIAL: "synthetic", SAFE_VALUE: "ok" };
    const expected = {
      allowed: { SAFE_VALUE: "ok" },
      blocked: ["PROVIDER_BILLING_CREDENTIAL"],
      warnings: [],
    };

    expect(sanitizeEnvVars(inherited)).toEqual(expected);
    expect(warnPluginSdkDeprecation).toHaveBeenCalledWith(
      expect.objectContaining({ replacement: "sanitizeEnvVarsAsync" }),
    );
    expect(await sanitizeEnvVarsAsync(inherited)).toEqual(expected);
  });

  it("observes newly published credential metadata on the next async call", async () => {
    vi.mocked(getCurrentPluginMetadataSnapshot).mockReturnValue(
      metadataWithBillingCredential("FIRST_BILLING_CREDENTIAL"),
    );
    const inherited = { FIRST_BILLING_CREDENTIAL: "first", SECOND_BILLING_CREDENTIAL: "second" };
    expect((await sanitizeEnvVarsAsync(inherited)).blocked).toEqual(["FIRST_BILLING_CREDENTIAL"]);

    vi.mocked(getCurrentPluginMetadataSnapshot).mockReturnValue(
      metadataWithBillingCredential("SECOND_BILLING_CREDENTIAL"),
    );
    expect((await sanitizeEnvVarsAsync(inherited)).blocked).toEqual(["SECOND_BILLING_CREDENTIAL"]);
    expect(loadLegacyPluginMetadataSnapshotRuntime).not.toHaveBeenCalled();
    expect(resolvePluginMetadataSnapshotAsync).not.toHaveBeenCalled();
  });
});
