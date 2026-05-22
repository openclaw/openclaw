import { n as describeAccountSnapshot } from "../../account-helpers-BsR7BVoK.js";
import { i as resolveMatrixAccount } from "../../accounts-DqzGihqe.js";
import { n as matrixConfigAdapter, t as MatrixChannelConfigSchema } from "../../config-schema-fsTgbphf.js";
import { n as matrixSetupAdapter, t as createMatrixSetupWizardProxy } from "../../setup-core-Dg40bdTQ.js";
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
	setupWizard: createMatrixSetupWizardProxy(async () => ({ matrixSetupWizard: (await import("../../setup-surface-BeuwJ5NV.js")).matrixSetupWizard })),
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
	configSchema: MatrixChannelConfigSchema,
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
