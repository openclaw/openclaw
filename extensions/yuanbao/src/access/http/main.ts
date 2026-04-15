/**
 * 元宝业务 API
 *
 * Includes: upload pre-sign config retrieval, resource download URL retrieval, and other business APIs.
 * 基础鉴权和 HTTP 工具见 request.ts。
 */

import type { ResolvedYuanbaoAccount } from "../../types.js";
import type { Log, CosUploadConfig } from "./request.js";
import { yuanbaoPost, yuanbaoGet } from "./request.js";

const UPLOAD_INFO_PATH = "/api/resource/genUploadInfo";
const DOWNLOAD_INFO_PATH = "/api/resource/v1/download";

// ============ 上传 API ============

/**
 * 获取 COS 上传预签配置
 *
 * @param account - 账号配置（用于鉴权）
 * @param fileName - 文件名（含扩展名）
 * @param fileId - 客户端生成的唯一文件 ID（hex 随机串）
 * @param log - 可选日志对象
 * @returns COS 上传预签配置，含 bucket、region、临时凭证等
 */
export async function apiGetUploadInfo(
  account: ResolvedYuanbaoAccount,
  fileName: string,
  fileId: string,
  log?: Log,
): Promise<CosUploadConfig> {
  const data = await yuanbaoPost<CosUploadConfig>(
    account,
    UPLOAD_INFO_PATH,
    { fileName, fileId, docFrom: "localDoc", docOpenId: "" },
    log,
  );

  if (!data.bucketName || !data.location) {
    throw new Error(`[yuanbao-api] genUploadInfo 配置不完整: ${JSON.stringify(data)}`);
  }

  return data;
}

// ============ 下载 API ============

/**
 * 用 resourceId 换取 COS 下载链接
 *
 * @param account - 账号配置（用于鉴权）
 * @param resourceId - 元宝资源 ID
 * @param log - 可选日志对象
 * @returns COS 下载 URL
 */
export async function apiGetDownloadUrl(
  account: ResolvedYuanbaoAccount,
  resourceId: string,
  log?: Log,
): Promise<string> {
  const data = await yuanbaoGet<{ url?: string; realUrl?: string }>(
    account,
    DOWNLOAD_INFO_PATH,
    { resourceId },
    log,
  );

  const downloadUrl = data.url ?? data.realUrl;
  if (!downloadUrl) {
    throw new Error(`[yuanbao-api] resource/v1/download 未返回有效 URL: ${JSON.stringify(data)}`);
  }

  return downloadUrl;
}
