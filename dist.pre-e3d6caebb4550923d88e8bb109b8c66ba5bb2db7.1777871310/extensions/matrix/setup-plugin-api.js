import { r as buildChannelConfigSchema } from "../../config-schema-C2n-k4o1.js";
import { n as describeAccountSnapshot } from "../../account-helpers-CTA0ZNCv.js";
import "../../channel-config-primitives-DtKw-oDC.js";
import { i as resolveMatrixAccount } from "../../accounts-9iJQ7pUi.js";
import { n as matrixConfigAdapter, t as MatrixConfigSchema } from "../../config-schema-CDnvOawN.js";
import { n as matrixSetupAdapter, t as createMatrixSetupWizardProxy } from "../../setup-core-yIGDAP96.js";
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
	setupWizard: createMatrixSetupWizardProxy(async () => ({ matrixSetupWizard: (await import("../../setup-surface-_W7tN8Am.js")).matrixSetupWizard })),
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
