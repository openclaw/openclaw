import { describePackageManifestContract } from "../../test/helpers/plugins/package-manifest-contract.js";

describePackageManifestContract({
	pluginId: "mattermost",
	minHostVersionBaseline: "2026.3.22",
});
