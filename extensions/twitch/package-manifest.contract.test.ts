import { describePackageManifestContract } from "../../test/helpers/extensions/package-manifest-contract.js";

describePackageManifestContract({
  pluginId: "twitch",
  minHostVersionBaseline: "2026.3.22",
});
