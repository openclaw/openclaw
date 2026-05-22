import type { StreamFn } from "@earendil-works/pi-agent-core";
import { decodeHtmlEntitiesInObject } from "../tool-call-argument-decoding.js";
export declare function wrapStreamFnRepairMalformedToolCallArguments(baseFn: StreamFn): StreamFn;
export declare function shouldRepairMalformedToolCallArguments(params: {
    provider?: string;
    modelApi?: string | null;
}): boolean;
export declare function wrapStreamFnDecodeXaiToolCallArguments(baseFn: StreamFn): StreamFn;
export { decodeHtmlEntitiesInObject };
