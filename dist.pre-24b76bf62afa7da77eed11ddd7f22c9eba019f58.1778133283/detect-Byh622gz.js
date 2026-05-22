import { t as detectZaiEndpoint$1 } from "./provider-zai-endpoint-DhTr2AIf.js";
import "./runtime-api-DlQnoExv.js";
//#region extensions/zai/detect.ts
let detectZaiEndpointImpl = detectZaiEndpoint$1;
async function detectZaiEndpoint(...args) {
	return await detectZaiEndpointImpl(...args);
}
//#endregion
export { detectZaiEndpoint as t };
