import { describePackageManifestContract } from "../../test/helpers/plugins/package-manifest-contract.js";

describePackageManifestContract({
	pluginId: "irc",
	minHostVersionBaseline: "2026.3.22",
});
