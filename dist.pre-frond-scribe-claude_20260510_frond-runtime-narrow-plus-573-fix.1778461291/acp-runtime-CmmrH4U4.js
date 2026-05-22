import "./errors-Qjv3JjUa.js";
import { t as __testing$1 } from "./registry-CA05kuze.js";
import { t as __testing$2 } from "./manager-CM1lPszS.js";
import "./session-meta-Mpw_eovt.js";
import "./acp-runtime-backend-Drd3TzMo.js";
//#region src/plugin-sdk/acp-runtime.ts
const __testing = new Proxy({}, {
	get(_target, prop, receiver) {
		if (Reflect.has(__testing$2, prop)) return Reflect.get(__testing$2, prop, receiver);
		return Reflect.get(__testing$1, prop, receiver);
	},
	has(_target, prop) {
		return Reflect.has(__testing$2, prop) || Reflect.has(__testing$1, prop);
	},
	ownKeys() {
		return Array.from(new Set([...Reflect.ownKeys(__testing$2), ...Reflect.ownKeys(__testing$1)]));
	},
	getOwnPropertyDescriptor(_target, prop) {
		if (Reflect.has(__testing$2, prop) || Reflect.has(__testing$1, prop)) return {
			configurable: true,
			enumerable: true
		};
	}
});
//#endregion
export { __testing as t };
