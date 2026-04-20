import type { ResolvedYuanbaoAccount } from "../../types.js";
import type { Log, CosUploadConfig } from "./request.js";
import { yuanbaoPost, yuanbaoGet } from "./request.js";

const UPLOAD_INFO_PATH = "/api/resource/genUploadInfo";
const DOWNLOAD_INFO_PATH = "/api/resource/v1/download";

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
    throw new Error(`[yuanbao-api] genUploadInfo incomplete config: ${JSON.stringify(data)}`);
  }

  return data;
}

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
    throw new Error(
      `[yuanbao-api] resource/v1/download returned no valid URL: ${JSON.stringify(data)}`,
    );
  }

  return downloadUrl;
}
