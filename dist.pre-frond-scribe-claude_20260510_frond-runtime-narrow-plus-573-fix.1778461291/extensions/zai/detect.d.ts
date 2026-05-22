import { n as ZaiEndpointId, r as detectZaiEndpoint$1, t as ZaiDetectedEndpoint } from "../../provider-zai-endpoint-CT0CuxQa.js";

//#region extensions/zai/detect.d.ts
type DetectZaiEndpointFn = typeof detectZaiEndpoint$1;
declare function detectZaiEndpoint(...args: Parameters<DetectZaiEndpointFn>): ReturnType<DetectZaiEndpointFn>;
//#endregion
export { type ZaiDetectedEndpoint, type ZaiEndpointId, detectZaiEndpoint };