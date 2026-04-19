import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { apiGetUploadInfo } from "../../../access/api.js";
import type { CosUploadConfig } from "../../../access/api.js";
import { createLog } from "../../../logger.js";
import type { ResolvedYuanbaoAccount, YuanbaoAccountConfig } from "../../../types.js";
import type { CosUploadResult, ParsedCommandArgs } from "./types.js";

type RecordApiResponse = {
  ok: boolean;
  logId?: string;
  cosPath?: string;
  cosUrl?: string;
  recordOk?: boolean;
  botId?: string;
  error?: string;
};

const DEFAULT_RECORD_API_URL = "https://yuanbao.tencent.com/e/api/clawLogUpload";

function resolveRecordApiUrl(config?: YuanbaoAccountConfig): string {
  const apiUrl = config?.logUploadApiUrl?.trim() || DEFAULT_RECORD_API_URL;
  if (!apiUrl) {
    throw new Error("缺少 logUploadApiUrl 配置或环境变量 YUANBAO_LOG_UPLOAD_API_URL");
  }
  return apiUrl;
}

function generateFileId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Upload Buffer data to Tencent Cloud COS.
 *
 * Same COS upload implementation as uploadBufferToCos in media.ts.
 * Initializes COS SDK with temp credentials from genUploadInfo, then calls putObject.
 * Uses dynamic import for cos-nodejs-sdk-v5, compatible with both CJS and ESM.
 */
async function uploadBufferToCos(config: CosUploadConfig, data: Buffer): Promise<string> {
  // Dynamic import, same loading strategy as media.ts
  let COS: unknown;
  try {
    COS = require("cos-nodejs-sdk-v5");
    if ((COS as Record<string, unknown>)?.default) {
      COS = (COS as Record<string, unknown>).default;
    }
  } catch {
    try {
      const pkg = await import("cos-nodejs-sdk-v5" as string);
      COS = pkg.default ?? pkg;
    } catch {
      throw new Error("缺少依赖 cos-nodejs-sdk-v5，请运行 pnpm add cos-nodejs-sdk-v5");
    }
  }

  const COSConstructor = COS as new (opts: Record<string, unknown>) => { putObject: (params: Record<string, unknown>) => Promise<unknown> };
  const cos = new COSConstructor({
    FileParallelLimit: 10,
    getAuthorization(_: unknown, callback: (cred: object) => void) {
      callback({
        TmpSecretId: config.encryptTmpSecretId,
        TmpSecretKey: config.encryptTmpSecretKey,
        SecurityToken: config.encryptToken,
        StartTime: config.startTime,
        ExpiredTime: config.expiredTime,
        ScopeLimit: true,
      });
    },
    UseAccelerate: true,
  });

  await cos.putObject({
    Bucket: config.bucketName,
    Region: config.region,
    Key: config.location,
    Body: data,
    Headers: { "Content-Type": "application/octet-stream" },
  });

  return config.resourceUrl;
}

/**
 * Send COS file info to backend API for auth and log registration.
 *
 * Calls clawLogUpload API with appKey/appSecret for sign-token auth,
 * and registers uploaded COS file path, time range, description, etc. to backend log system.
 */
async function recordViaApi(
  cosKey: string,
  cosUrl: string,
  args: ParsedCommandArgs,
  account: ResolvedYuanbaoAccount,
): Promise<RecordApiResponse> {
  const mlog = createLog("cos-upload");
  const { appKey, appSecret, apiDomain, routeEnv } = args;
  if (!appKey || !appSecret) {
    throw new Error("缺少 appKey 或 appSecret，无法校验凭证");
  }

  const apiUrl = resolveRecordApiUrl(account.config);
  mlog.info("sending cosKey to backend for log recording", { apiUrl, cosKey });

  const rsp = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appKey,
      appSecret,
      apiDomain: apiDomain || "bot.yuanbao.tencent.com",
      routeEnv: routeEnv || "",
      cosKey,
      cosUrl,
      uin: args.uin || "unknown",
      startTime: args.startTime,
      endTime: args.endTime,
      description: args.description || "",
    }),
  });

  if (!rsp.ok) {
    const errBody = (await rsp.json().catch(() => ({}))) as { error?: string };
    const msg = errBody.error || `HTTP ${rsp.status}`;
    throw new Error(`日志记录失败: ${msg} (${apiUrl})`);
  }

  return (await rsp.json()) as RecordApiResponse;
}

/**
 * Upload gzip-compressed log file to COS and register with backend.
 *
 * Complete log upload flow:
 * 1. Read local gzip file content
 * 2. Get COS temp credentials and pre-signed config via genUploadInfo
 * 3. Upload file to COS using cos-nodejs-sdk-v5
 * 4. Call backend API for auth and log metadata registration
 *
 * When args.uploadCos is false, returns `{ enabled: false }` to skip upload.
 */
export async function uploadToCos(
  gzipPath: string,
  args: ParsedCommandArgs,
  account: ResolvedYuanbaoAccount,
): Promise<CosUploadResult> {
  if (!args.uploadCos) {
    return { enabled: false };
  }

  const mlog = createLog("cos-upload");
  const fileBuffer = await readFile(gzipPath);
  const fileName = basename(gzipPath);
  const fileId = generateFileId();

  // 1. Get COS pre-signed config (same API as media.ts: genUploadInfo)
  mlog.info("fetching COS pre-signed config via genUploadInfo", { fileName, fileId });
  const cosConfig = await apiGetUploadInfo(account, fileName, fileId);

  // 2. Upload to COS (same as media.ts uploadBufferToCos)
  mlog.info("starting COS upload", { bucket: cosConfig.bucketName, key: cosConfig.location });
  await uploadBufferToCos(cosConfig, fileBuffer);
  mlog.info("COS upload complete", { cosKey: cosConfig.location, cosUrl: cosConfig.resourceUrl });

  // 3. Send cosKey to backend for log registration
  const result = await recordViaApi(cosConfig.location, cosConfig.resourceUrl, args, account);

  if (!result.ok) {
    throw new Error(result.error || "日志记录失败");
  }

  return {
    enabled: true,
    cosPath: cosConfig.resourceUrl,
    cosUrl: cosConfig.resourceUrl,
    logId: result.logId,
    recordLogOk: result.recordOk,
  };
}
