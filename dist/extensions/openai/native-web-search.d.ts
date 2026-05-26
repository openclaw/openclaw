import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/openai/native-web-search.d.ts
type OpenAINativeWebSearchPatchResult = "payload_not_object" | "native_tool_already_present" | "injected";
declare function patchOpenAINativeWebSearchPayload(payload: unknown): OpenAINativeWebSearchPatchResult;
declare function createOpenAINativeWebSearchWrapper(baseStreamFn: StreamFn | undefined, params: {
  config?: OpenClawConfig;
}): StreamFn;
//#endregion
export { createOpenAINativeWebSearchWrapper, patchOpenAINativeWebSearchPayload };