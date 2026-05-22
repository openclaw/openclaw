import "./errors-zyHRqIKC.js";
import { i as testing$1 } from "./registry-DgyKnqoq.js";
import { n as testing$2 } from "./manager-nmtPpuoA.js";
import "./session-meta-BYrzXCjT.js";
import "./acp-runtime-backend-BBKdxD3a.js";
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
