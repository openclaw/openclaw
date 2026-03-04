import axios from "axios";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAccessToken } from "./client.js";
import { sendDingtalkDM, sendDingtalkGroup } from "./send.js";
import type { ResolvedDingtalkAccount, DingtalkSendResult } from "./types.js";

// 钉钉媒体文件类型 / DingTalk media file types
export type DingtalkMediaType = "image" | "voice" | "video" | "file";

const DINGTALK_OAPI_BASE = "https://oapi.dingtalk.com";

/**
 * 上传媒体文件到钉钉 / Upload media file to DingTalk
 *
 * POST https://oapi.dingtalk.com/media/upload?access_token=xxx&type=image|voice|video|file
 * 返回 media_id / Returns media_id
 */
export async function uploadMedia(params: {
  account: ResolvedDingtalkAccount;
  filePath: string;
  type: DingtalkMediaType;
}): Promise<string> {
  const { account, filePath, type } = params;
  const accessToken = await getAccessToken(account);

  const FormData = (await import("node:stream")).Readable;
  const fileStream = fs.createReadStream(filePath);
  const fileName = path.basename(filePath);

  const formData = new (await import("form-data")).default();
  formData.append("media", fileStream, fileName);

  const res = await axios.post(
    `${DINGTALK_OAPI_BASE}/media/upload`,
    formData,
    {
      params: {
        access_token: accessToken,
        type,
      },
      headers: formData.getHeaders(),
    },
  );

  if (res.data?.media_id) {
    return res.data.media_id;
  }

  throw new Error(`Failed to upload media: ${JSON.stringify(res.data)}`);
}

/**
 * 下载机器人接收消息中的文件 / Download file from robot received message
 *
 * POST /v1.0/robot/messageFiles/download
 */
export async function downloadMessageFile(params: {
  account: ResolvedDingtalkAccount;
  downloadCode: string;
  robotCode: string;
}): Promise<{ downloadUrl: string }> {
  const { account, downloadCode, robotCode } = params;
  const accessToken = await getAccessToken(account);

  const res = await axios.post(
    `https://api.dingtalk.com/v1.0/robot/messageFiles/download`,
    { downloadCode, robotCode },
    {
      headers: {
        "x-acs-dingtalk-access-token": accessToken,
        "Content-Type": "application/json",
      },
    },
  );

  return { downloadUrl: res.data?.downloadUrl ?? "" };
}

/**
 * 发送图片消息 / Send image message
 */
export async function sendImageMessage(params: {
  account: ResolvedDingtalkAccount;
  conversationType: "1" | "2";
  conversationId: string;
  senderStaffId: string;
  photoURL: string;
}): Promise<DingtalkSendResult> {
  const { account, conversationType, conversationId, senderStaffId, photoURL } = params;
  const msgParam = JSON.stringify({ photoURL });

  if (conversationType === "1") {
    return sendDingtalkDM({
      account,
      userIds: [senderStaffId],
      msgKey: "sampleImageMsg",
      msgParam,
    });
  }

  return sendDingtalkGroup({
    account,
    openConversationId: conversationId,
    msgKey: "sampleImageMsg",
    msgParam,
  });
}

/**
 * 发送文件消息 / Send file message
 */
export async function sendFileMessage(params: {
  account: ResolvedDingtalkAccount;
  conversationType: "1" | "2";
  conversationId: string;
  senderStaffId: string;
  mediaId: string;
  fileName: string;
  fileType: string;
}): Promise<DingtalkSendResult> {
  const { account, conversationType, conversationId, senderStaffId, mediaId, fileName, fileType } =
    params;
  const msgParam = JSON.stringify({ mediaId, fileName, fileType });

  if (conversationType === "1") {
    return sendDingtalkDM({
      account,
      userIds: [senderStaffId],
      msgKey: "sampleFile",
      msgParam,
    });
  }

  return sendDingtalkGroup({
    account,
    openConversationId: conversationId,
    msgKey: "sampleFile",
    msgParam,
  });
}
