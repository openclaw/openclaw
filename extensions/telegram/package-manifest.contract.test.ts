import { describePackageManifestContract } from "../../test/helpers/extensions/package-manifest-contract.js";

describePackageManifestContract({
  pluginId: "telegram",
  runtimeDeps: ["grammy"],
});
