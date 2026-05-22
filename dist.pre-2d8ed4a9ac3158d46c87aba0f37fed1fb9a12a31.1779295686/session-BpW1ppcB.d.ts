import { r as GroupKeyResolution } from "./types-CG0p47bR.js";
import { n as MsgContext } from "./templating-CHXbK73c.js";
import { t as InboundLastRouteUpdate } from "./session.types-BD81Ttw3.js";

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