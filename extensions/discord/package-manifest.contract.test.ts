import { describePackageManifestContract } from "../../test/helpers/plugins/package-manifest-contract.js";

describePackageManifestContract({
	pluginId: "discord",
	runtimeDeps: ["@buape/carbon", "https-proxy-agent"],
	minHostVersionBaseline: "2026.3.22",
});
