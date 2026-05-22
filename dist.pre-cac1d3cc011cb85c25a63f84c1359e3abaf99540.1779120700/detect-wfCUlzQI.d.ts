//#region extensions/zai/detect.d.ts
type ZaiEndpointId = "global" | "cn" | "coding-global" | "coding-cn";
type ZaiDetectedEndpoint = {
  endpoint: ZaiEndpointId; /** Provider baseUrl to store in config. */
  baseUrl: string; /** Recommended default model id for that endpoint. */
  modelId: string; /** Human-readable note explaining the choice. */
  note: string;
};
declare function detectZaiEndpoint(params: {
  apiKey: string;
  endpoint?: ZaiEndpointId;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<ZaiDetectedEndpoint | null>;
//#endregion
export { ZaiEndpointId as n, detectZaiEndpoint as r, ZaiDetectedEndpoint as t };