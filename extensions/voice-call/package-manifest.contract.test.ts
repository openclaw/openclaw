import { describePackageManifestContract } from "../../test/helpers/plugins/package-manifest-contract.js";

describePackageManifestContract({
  pluginId: "voice-call",
  minHostVersionBaseline: "2026.3.22",
});
