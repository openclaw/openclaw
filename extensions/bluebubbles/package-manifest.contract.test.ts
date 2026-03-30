import { describePackageManifestContract } from "../../test/helpers/plugins/package-manifest-contract.js";

describePackageManifestContract({
	pluginId: "bluebubbles",
	minHostVersionBaseline: "2026.3.22",
});
