import { describePackageManifestContract } from "../../test/helpers/extensions/package-manifest-contract.js";

describePackageManifestContract({
  pluginId: "msteams",
  minHostVersionBaseline: "2026.3.22",
});
