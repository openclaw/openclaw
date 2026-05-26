import { i as OpenClawConfig } from "../types.openclaw-DIZy8jcb.js";
import { n as MsgContext } from "../templating-BcdAlwzB.js";

//#region src/link-understanding/apply.d.ts
type ApplyLinkUnderstandingResult = {
  outputs: string[];
  urls: string[];
};
declare function applyLinkUnderstanding(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
}): Promise<ApplyLinkUnderstandingResult>;
//#endregion
export { applyLinkUnderstanding };