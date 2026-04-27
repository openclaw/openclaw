import type { StreamFn } from "@mariozechner/pi-agent-core";
import { decodeHtmlEntitiesInObject } from "../../../plugin-sdk/provider-stream-shared.js";
export declare function wrapStreamFnRepairMalformedToolCallArguments(baseFn: StreamFn): StreamFn;
export declare function shouldRepairMalformedToolCallArguments(params: {
    provider?: string;
    modelApi?: string | null;
}): boolean;
export declare function wrapStreamFnDecodeXaiToolCallArguments(baseFn: StreamFn): StreamFn;
export { decodeHtmlEntitiesInObject };
