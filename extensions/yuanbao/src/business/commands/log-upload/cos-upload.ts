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
 * 将 Buffer 数据上传到腾讯云 COS
 *
 * 与 media.ts 中 uploadBufferToCos 完全一致的 COS 上传实现。
 * 通过 genUploadInfo 获取的临时凭证初始化 COS SDK，再调用 putObject 上传文件。
 * 使用动态 import 加载 cos-nodejs-sdk-v5，兼容 CommonJS 和 ESM 两种模块系统。
 *
 * @param config - COS 上传配置，包含临时密钥、Bucket、Region、文件路径等信息
 * @param data - 待上传的文件内容（Buffer 格式）
 * @returns 上传成功后的资源访问 URL（config.resourceUrl）
 * @throws 当 cos-nodejs-sdk-v5 依赖缺失或上传失败时抛出错误
 */
async function uploadBufferToCos(config: CosUploadConfig, data: Buffer): Promise<string> {
  // 动态 import，与 media.ts 保持完全一致的加载策略
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
 * 将 COS 文件信息发送到后端 API 进行鉴权和日志登记
 *
 * 调用 clawLogUpload API 接口，携带 appKey/appSecret 进行 sign-token 鉴权，
 * 并将已上传的 COS 文件路径、时间范围、Description等元信息登记到后端日志系统。
 * API 地址优先从账号配置读取，其次从Environment variables读取，最后降级到Default地址。
 *
 * @param cosKey - COS 文件存储路径（如 `logs/2024/xxx.gz`）
 * @param cosUrl - COS 文件的完整访问 URL
 * @param args - 命令行解析参数，包含 appKey、appSecret、apiDomain、时间范围等
 * @param account - 已解析的元宝账号信息，用于获取 logUploadApiUrl 配置
 * @returns 后端 API 的响应结果，包含 logId、recordOk 等字段
 * @throws 当 appKey/appSecret 缺失或 API 请求失败时抛出错误
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
 * 将 gzip 压缩的日志文件上传到 COS 并登记到后端
 *
 * Complete log upload flow:
 * 1. 读取本地 gzip 文件内容
 * 2. 通过 genUploadInfo 接口获取 COS 临时凭证和预签配置
 * 3. 使用 cos-nodejs-sdk-v5 将文件上传到 COS
 * 4. 调用后端 API 进行鉴权并登记日志元信息
 *
 * 当 args.uploadCos 为 false 时直接返回 `{ enabled: false }` 跳过上传。
 *
 * @param gzipPath - 本地 gzip 文件的绝对路径
 * @param args - 命令行解析参数，包含 uploadCos 开关、appKey、appSecret 等
 * @param account - 已解析的元宝账号信息，用于获取上传凭证和 API 配置
 * @returns 上传结果，enabled 为 true 时包含 cosPath、logId 等信息
 * @throws 当 COS 上传失败或后端日志登记失败时抛出错误
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

  // 1. 获取 COS 预签配置（与 media.ts 同一接口: genUploadInfo）
  mlog.info("fetching COS pre-signed config via genUploadInfo", { fileName, fileId });
  const cosConfig = await apiGetUploadInfo(account, fileName, fileId);

  // 2. 上传到 COS（与 media.ts uploadBufferToCos 完全一致）
  mlog.info("starting COS upload", { bucket: cosConfig.bucketName, key: cosConfig.location });
  await uploadBufferToCos(cosConfig, fileBuffer);
  mlog.info("COS upload complete", { cosKey: cosConfig.location, cosUrl: cosConfig.resourceUrl });

  // 3. 把 cosKey 发到后端做日志登记
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
