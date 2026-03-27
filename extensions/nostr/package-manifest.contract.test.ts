import { describePackageManifestContract } from "../../test/helpers/extensions/package-manifest-contract.js";

describePackageManifestContract({
  pluginId: "nostr",
  minHostVersionBaseline: "2026.3.22",
});
