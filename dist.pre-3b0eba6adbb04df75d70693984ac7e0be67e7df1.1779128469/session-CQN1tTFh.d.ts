import { r as GroupKeyResolution } from "./types-CWcVAdid.js";
import { n as MsgContext } from "./templating-DWddnfaD.js";
import { t as InboundLastRouteUpdate } from "./session.types-BUVuMTN3.js";

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