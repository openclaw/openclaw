import { t as ChannelId } from "./channel-id.types-ClK6B_QE.js";

//#region src/infra/channel-activity.d.ts
type ChannelDirection = "inbound" | "outbound";
type ActivityEntry = {
  inboundAt: number | null;
  outboundAt: number | null;
};
declare function recordChannelActivity(params: {
  channel: ChannelId;
  accountId?: string | null;
  direction: ChannelDirection;
  at?: number;
}): void;
declare function getChannelActivity(params: {
  channel: ChannelId;
  accountId?: string | null;
}): ActivityEntry;
declare function resetChannelActivityForTest(): void;
//#endregion
export { resetChannelActivityForTest as i, getChannelActivity as n, recordChannelActivity as r, ChannelDirection as t };