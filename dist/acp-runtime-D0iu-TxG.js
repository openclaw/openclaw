import "./errors-CKqjOH1Z.js";
import { t as __testing$1 } from "./manager-D1tsINaa.js";
import { t as __testing$2 } from "./registry-xA2gDhdp.js";
import "./session-meta-BddX6ju1.js";
import "./acp-runtime-backend-LC5BzNoV.js";
//#region src/plugin-sdk/acp-runtime.ts
const __testing = new Proxy({}, {
	get(_target, prop, receiver) {
		if (Reflect.has(__testing$1, prop)) return Reflect.get(__testing$1, prop, receiver);
		return Reflect.get(__testing$2, prop, receiver);
	},
	has(_target, prop) {
		return Reflect.has(__testing$1, prop) || Reflect.has(__testing$2, prop);
	},
	ownKeys() {
		return Array.from(new Set([...Reflect.ownKeys(__testing$1), ...Reflect.ownKeys(__testing$2)]));
	},
	getOwnPropertyDescriptor(_target, prop) {
		if (Reflect.has(__testing$1, prop) || Reflect.has(__testing$2, prop)) return {
			configurable: true,
			enumerable: true
		};
	}
});
//#endregion
export { __testing as t };
