import { describePackageManifestContract } from "../../test/helpers/plugins/package-manifest-contract.js";

describePackageManifestContract({
  pluginId: "slack",
  runtimeDeps: ["@slack/bolt"],
});
