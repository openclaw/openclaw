import { describePackageManifestContract } from "../../test/helpers/extensions/package-manifest-contract.js";

describePackageManifestContract({
  pluginId: "voice-call",
  minHostVersionBaseline: "2026.3.22",
});
