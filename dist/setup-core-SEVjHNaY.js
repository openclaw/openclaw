import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import "./temp-path-DllZid8c.js";
import { i as createPatchedAccountSetupAdapter } from "./setup-helpers-BC9z9VvG.js";
import { t as createSetupTranslator } from "./i18n-CWNhN747.js";
import { a as createDelegatedSetupWizardProxy } from "./setup-wizard-proxy-B15glc8O.js";
import "./setup-runtime-BRbeJqWD.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region extensions/zalouser/src/qr-temp-file.ts
async function writeQrDataUrlToTempFile(qrDataUrl, profile) {
	const base64 = (qrDataUrl.trim().match(/^data:image\/png;base64,(.+)$/i)?.[1] ?? "").trim();
	if (!base64) return null;
	const safeProfile = profile.replace(/[^a-zA-Z0-9_-]+/g, "-") || "default";
	const filePath = path.join(resolvePreferredOpenClawTmpDir(), `openclaw-zalouser-qr-${safeProfile}.png`);
	await fs.writeFile(filePath, Buffer.from(base64, "base64"));
	return filePath;
}
//#endregion
//#region extensions/zalouser/src/setup-core.ts
const t = createSetupTranslator();
const channel = "zalouser";
const zalouserSetupAdapter = createPatchedAccountSetupAdapter({
	channelKey: channel,
	validateInput: () => null,
	buildPatch: () => ({})
});
function createZalouserSetupWizardProxy(loadWizard) {
	return createDelegatedSetupWizardProxy({
		channel,
		loadWizard,
		status: {
			configuredLabel: t("wizard.channels.statusLoggedIn"),
			unconfiguredLabel: t("wizard.channels.statusNeedsQrLogin"),
			configuredHint: t("wizard.channels.statusRecommendedLoggedIn"),
			unconfiguredHint: t("wizard.channels.statusRecommendedQrLogin"),
			configuredScore: 1,
			unconfiguredScore: 15
		},
		credentials: [],
		delegatePrepare: true,
		delegateFinalize: true
	});
}
//#endregion
export { zalouserSetupAdapter as n, writeQrDataUrlToTempFile as r, createZalouserSetupWizardProxy as t };
