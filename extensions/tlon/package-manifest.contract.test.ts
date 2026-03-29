import { describePackageManifestContract } from "../../test/helpers/plugins/package-manifest-contract.js";

describePackageManifestContract({
  pluginId: "tlon",
  minHostVersionBaseline: "2026.3.22",
});
