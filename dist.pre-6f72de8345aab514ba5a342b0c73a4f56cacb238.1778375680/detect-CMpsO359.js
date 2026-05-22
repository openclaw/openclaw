import { t as detectZaiEndpoint$1 } from "./provider-zai-endpoint-B0p7APTi.js";
import "./runtime-api-B7XBc3bb.js";
//#region extensions/zai/detect.ts
let detectZaiEndpointImpl = detectZaiEndpoint$1;
async function detectZaiEndpoint(...args) {
	return await detectZaiEndpointImpl(...args);
}
//#endregion
export { detectZaiEndpoint as t };
