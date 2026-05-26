import { r as GroupKeyResolution } from "./types-ChLEnNVH.js";
import { n as MsgContext } from "./templating-DbSpLCuR.js";
import { t as InboundLastRouteUpdate } from "./session.types-B-nEI62r.js";

//#region src/channels/session.d.ts
declare function recordInboundSession(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
  updateLastRoute?: InboundLastRouteUpdate;
  onRecordError: (err: unknown) => void;
  trackSessionMetaTask?: (task: Promise<unknown>) => void;
}): Promise<void>;
//#endregion
export { recordInboundSession as t };