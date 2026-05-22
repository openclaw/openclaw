import { r as buildChannelConfigSchema } from "../../config-schema-Cv6_wz1q.js";
import { n as describeAccountSnapshot } from "../../account-helpers-CZufvFy_.js";
import "../../channel-config-primitives-C__G3q35.js";
import { i as resolveMatrixAccount } from "../../accounts-BqUwiwKD.js";
import { n as matrixConfigAdapter, t as MatrixConfigSchema } from "../../config-schema-vVS7YN22.js";
import { n as matrixSetupAdapter, t as createMatrixSetupWizardProxy } from "../../setup-core-BsdCZZdP.js";
const matrixSetupPlugin = {
	id: "matrix",
	meta: {
		id: "matrix",
		label: "Matrix",
		selectionLabel: "Matrix (plugin)",
		docsPath: "/channels/matrix",
		docsLabel: "matrix",
		blurb: "open protocol; configure a homeserver + access token.",
		order: 70,
		quickstartAllowFrom: true
	},
	setupWizard: createMatrixSetupWizardProxy(async () => ({ matrixSetupWizard: (await import("../../setup-surface-cX54A1FS.js")).matrixSetupWizard })),
	setup: matrixSetupAdapter,
	capabilities: {
		chatTypes: [
			"direct",
			"group",
			"thread"
		],
		polls: true,
		reactions: true,
		threads: true,
		media: true
	},
	reload: { configPrefixes: ["channels.matrix"] },
	configSchema: buildChannelConfigSchema(MatrixConfigSchema),
	config: {
		...matrixConfigAdapter,
		isConfigured: (account) => account.configured,
		describeAccount: (account) => describeAccountSnapshot({
			account,
			configured: account.configured,
			extra: { baseUrl: account.homeserver }
		}),
		hasConfiguredState: ({ cfg }) => resolveMatrixAccount({ cfg }).configured
	}
};
//#endregion
export { matrixSetupPlugin };
