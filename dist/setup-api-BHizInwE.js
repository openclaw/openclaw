import { r as loadBundledEntryExportSync } from "./channel-entry-contract-BDMmGZzs.js";
import "./setup-core-B97EObg2.js";
//#region extensions/zalo/setup-api.ts
function createLazyObjectValue(load) {
	return new Proxy({}, {
		get(_target, property, receiver) {
			return Reflect.get(load(), property, receiver);
		},
		has(_target, property) {
			return property in load();
		},
		ownKeys() {
			return Reflect.ownKeys(load());
		},
		getOwnPropertyDescriptor(_target, property) {
			const descriptor = Object.getOwnPropertyDescriptor(load(), property);
			return descriptor ? {
				...descriptor,
				configurable: true
			} : void 0;
		}
	});
}
function loadSetupSurfaceModule() {
	return loadBundledEntryExportSync(import.meta.url, { specifier: "./src/setup-surface.js" });
}
const zaloSetupWizard = createLazyObjectValue(() => loadSetupSurfaceModule().zaloSetupWizard);
//#endregion
export { zaloSetupWizard as t };
