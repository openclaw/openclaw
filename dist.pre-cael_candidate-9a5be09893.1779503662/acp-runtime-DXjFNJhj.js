import "./errors-CLAwtSsK.js";
import { i as testing$1 } from "./registry-wy_5WbzN.js";
import { n as testing$2 } from "./manager-hUYL8hIL.js";
import "./session-meta-Db5t-aL6.js";
import "./acp-runtime-backend-CBLUecCY.js";
//#region src/plugin-sdk/acp-runtime.ts
const testing = new Proxy({}, {
	get(_target, prop, receiver) {
		if (Reflect.has(testing$2, prop)) return Reflect.get(testing$2, prop, receiver);
		return Reflect.get(testing$1, prop, receiver);
	},
	has(_target, prop) {
		return Reflect.has(testing$2, prop) || Reflect.has(testing$1, prop);
	},
	ownKeys() {
		return Array.from(new Set([...Reflect.ownKeys(testing$2), ...Reflect.ownKeys(testing$1)]));
	},
	getOwnPropertyDescriptor(_target, prop) {
		if (Reflect.has(testing$2, prop) || Reflect.has(testing$1, prop)) return {
			configurable: true,
			enumerable: true
		};
	}
});
//#endregion
export { testing as t };
