import { describePackageManifestContract } from "../../test/helpers/extensions/package-manifest-contract.js";

describePackageManifestContract({
  pluginId: "slack",
  runtimeDeps: ["@slack/bolt"],
});
