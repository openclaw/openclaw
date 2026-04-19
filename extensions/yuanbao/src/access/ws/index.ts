export {
  encodePB,
  decodePB,
  encodeConnMsg,
  decodeConnMsg,
  buildAuthBindMsg,
  buildPingMsg,
  buildPushAck,
  buildBusinessConnMsg,
  createHead,
  nextSeqNo,
  PB_MSG_TYPES,
  CMD_TYPE,
  CMD,
  MODULE,
} from "./conn-codec.js";
export type { PBHead, PBConnMsg } from "./conn-codec.js";

export {
  encodeBizPB,
  decodeBizPB,
  toProtoMsgBody,
  fromProtoMsgBody,
  encodeSendC2CMessageReq,
  encodeSendGroupMessageReq,
  encodeSendPrivateHeartbeatReq,
  encodeSendGroupHeartbeatReq,
  decodeInboundMessage,
  decodeSendC2CMessageRsp,
  decodeSendGroupMessageRsp,
  decodeSendMessageRsp,
  decodeSendPrivateHeartbeatRsp,
  decodeSendGroupHeartbeatRsp,
  encodeQueryGroupInfoReq,
  decodeQueryGroupInfoRsp,
  encodeGetGroupMemberListReq,
  decodeGetGroupMemberListRsp,
  encodeSyncInformationReq,
  decodeSyncInformationRsp,
  BIZ_MSG_TYPES,
} from "./biz-codec.js";

export { YuanbaoWsClient, BIZ_CMD } from "./client.js";

export { startYuanbaoWsGateway, wsPushToInboundMessage } from "./gateway.js";
export type { StartWsGatewayParams } from "./gateway.js";

export { setActiveWsClient, getActiveWsClient, getAllActiveWsClients } from "./runtime.js";

export { WS_HEARTBEAT } from "./types.js";

export type {
  WsConnectionConfig,
  WsClientConfig,
  WsClientState,
  WsAuthBindResult,
  WsClientCallbacks,
  WsPushEvent,
  WsSendC2CMessageData,
  WsSendGroupMessageData,
  WsSendPrivateHeartbeatData,
  WsSendGroupHeartbeatData,
  WsOutboundMessageData,
  WsSendMessageResponse,
  WsHeartbeatResponse,
  WsHeartbeatValue,
  WsQueryGroupInfoData,
  WsQueryGroupInfoResponse,
  WsGroupInfo,
  WsGetGroupMemberListData,
  WsGetGroupMemberListResponse,
  WsGroupMember,
  WsSyncInformationData,
  WsSyncInformationResponse,
  WsSyncCommand,
  WsSyncCommandsData,
} from "./types.js";
