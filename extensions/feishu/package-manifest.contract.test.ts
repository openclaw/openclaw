import { describePackageManifestContract } from "../../test/helpers/extensions/package-manifest-contract.js";

describePackageManifestContract({
  pluginId: "feishu",
  runtimeDeps: ["@larksuiteoapi/node-sdk"],
  minHostVersionBaseline: "2026.3.22",
});
