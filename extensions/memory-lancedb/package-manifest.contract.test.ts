import { describePackageManifestContract } from "../../test/helpers/plugins/package-manifest-contract.js";

describePackageManifestContract({
  pluginId: "memory-lancedb",
  runtimeDeps: ["@lancedb/lancedb"],
  minHostVersionBaseline: "2026.3.22",
});
