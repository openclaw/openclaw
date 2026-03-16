import {
  detectZaiEndpoint as detectZaiEndpointCore,
  type ZaiDetectedEndpoint,
  type ZaiEndpointId,
} from "../../src/commands/zai-endpoint-detect.js";

type DetectZaiEndpointFn = typeof detectZaiEndpointCore;

let detectZaiEndpointImpl: DetectZaiEndpointFn = detectZaiEndpointCore;

export function setDetectZaiEndpointForTesting(fn?: DetectZaiEndpointFn): void {
  detectZaiEndpointImpl = fn ?? detectZaiEndpointCore;
}

export async function detectZaiEndpoint(
  ...args: Parameters<DetectZaiEndpointFn>
): ReturnType<DetectZaiEndpointFn> {
  return await detectZaiEndpointImpl(...args);
}

export type { ZaiDetectedEndpoint, ZaiEndpointId };
