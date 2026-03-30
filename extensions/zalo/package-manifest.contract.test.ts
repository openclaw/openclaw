import { describePackageManifestContract } from "../../test/helpers/plugins/package-manifest-contract.js";

describePackageManifestContract({
	pluginId: "zalo",
	minHostVersionBaseline: "2026.3.22",
});
