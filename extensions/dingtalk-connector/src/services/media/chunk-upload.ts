/**
 * 钉钉文件分块上传模块
 * 支持大文件（>20MB）的分块上传
 * 
 * API 文档：
 * - 开启事务：https://open.dingtalk.com/document/development/enable-upload-transaction
 * - 上传块：https://open.dingtalk.com/document/development/upload-file-blocks
 * - 提交事务：https://open.dingtalk.com/document/development/submit-a-file-upload-transaction
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../utils/logger.ts';
import { dingtalkOapiHttp, dingtalkUploadHttp } from '../../utils/http-client.ts';
// form-data 是 CJS 模块，静态 import 可确保 jiti/ESM 环境下 CJS 互操作行为稳定，
// 避免动态 import 时 .default 偶发为 undefined 导致 "Cannot read properties of undefined (reading 'registry')"
import FormData from 'form-data';

const DINGTALK_OAPI = 'https://oapi.dingtalk.com';

/** 分块上传配置 */
export const CHUNK_CONFIG = {
  MIN_CHUNK_SIZE: 100 * 1024, // 最小分块 100KB
  MAX_CHUNK_SIZE: 8 * 1024 * 1024, // 最大分块 8MB
  DEFAULT_CHUNK_SIZE: 5 * 1024 * 1024, // 默认分块 5MB
  SIZE_THRESHOLD: 20 * 1024 * 1024, // 超过 20MB 使用分块上传
};

/** 开启上传事务响应 */
interface UploadTransactionResponse {
  errcode: number;
  errmsg: string;
  upload_id: string;
}

/** 上传文件块响应 */
interface UploadBlockResponse {
  errcode: number;
  errmsg: string;
}

/** 提交上传事务响应 */
interface SubmitTransactionResponse {
  errcode: number;
  errmsg: string;
  file_id?: string;
  download_code?: string;
}

/**
 * 步骤一：开启分块上传事务
 * @param oapiToken 钉钉 access_token
 * @param fileName 文件名
 * @param fileSize 文件大小（字节）
 * @param log 日志对象
 */
export async function enableUploadTransaction(
  oapiToken: string,
  fileName: string,
  fileSize: number,
  debug: boolean = false,
): Promise<string | null> {
  const log = createLogger(debug, 'DingTalk][ChunkUpload');
  
  try {
    log.info(`开启上传事务：${fileName}, 大小：${(fileSize / 1024 / 1024).toFixed(2)}MB`);

    const form = new FormData();
    form.append('file_name', fileName);
    form.append('file_size', fileSize.toString());

    const resp = await dingtalkOapiHttp.post<UploadTransactionResponse>(
      `${DINGTALK_OAPI}/file/upload/transaction/enable`,
      form,
      {
        params: { access_token: oapiToken },
        headers: form.getHeaders(),
        timeout: 60_000,
      }
    );

    if (resp.data.errcode === 0) {
      log.info(`事务开启成功，upload_id: ${resp.data.upload_id}`);
      return resp.data.upload_id;
    } else {
      log.error(`开启事务失败：${resp.data.errmsg}`);
      return null;
    }
  } catch (err: any) {
    log.error(`开启事务异常：${err.message}`);
    console.error(`开启事务异常详情:`, err.response?.data || err);
    return null;
  }
}

/**
 * 步骤二：上传文件块
 * @param oapiToken 钉钉 access_token
 * @param uploadId 上传事务 ID
 * @param chunkData 文件块数据
 * @param chunkNumber 块编号（从 1 开始）
 * @param totalChunks 总块数
 * @param log 日志对象
 */
export async function uploadFileBlock(
  oapiToken: string,
  uploadId: string,
  chunkData: Buffer,
  chunkNumber: number,
  totalChunks: number,
  debug: boolean = false,
): Promise<boolean> {
  const log = createLogger(debug, 'DingTalk][ChunkUpload');
  
  try {
    log.info(`上传块 ${chunkNumber}/${totalChunks}, 大小：${(chunkData.length / 1024).toFixed(2)}KB`);

    const form = new FormData();
    form.append('upload_id', uploadId);
    form.append('chunk_number', chunkNumber.toString());
    form.append('total_chunks', totalChunks.toString());
    form.append('file', chunkData, {
      filename: `chunk_${chunkNumber}`,
      contentType: 'application/octet-stream',
    });

    const resp = await dingtalkOapiHttp.post<UploadBlockResponse>(
      `${DINGTALK_OAPI}/file/upload/chunk`,
      form,
      {
        params: { access_token: oapiToken },
        headers: form.getHeaders(),
        timeout: 60_000,
      }
    );

    if (resp.data.errcode === 0) {
      log.info(`块 ${chunkNumber} 上传成功`);
      return true;
    } else {
      log.error(`块 ${chunkNumber} 上传失败：${resp.data.errmsg}`);
      return false;
    }
  } catch (err: any) {
    log.error(`块 ${chunkNumber} 上传异常：${err.message}`);
    return false;
  }
}

/**
 * 步骤三：提交分块上传事务
 * @param oapiToken 钉钉 access_token
 * @param uploadId 上传事务 ID
 * @param fileName 文件名
 * @param log 日志对象
 */
export async function submitUploadTransaction(
  oapiToken: string,
  uploadId: string,
  fileName: string,
  debug: boolean = false,
): Promise<{ fileId?: string; downloadCode?: string } | null> {
  const log = createLogger(debug, 'DingTalk][ChunkUpload');
  
  try {
    log.info(`提交上传事务：${uploadId}`);

    const resp = await dingtalkOapiHttp.get<SubmitTransactionResponse>(
      `${DINGTALK_OAPI}/file/upload/transaction/submit`,
      {
        params: {
          access_token: oapiToken,
          upload_id: uploadId,
          file_name: fileName,
        },
        timeout: 60_000,
      }
    );

    if (resp.data.errcode === 0) {
      log.info(`事务提交成功，file_id: ${resp.data.file_id}, download_code: ${resp.data.download_code}`);
      return {
        fileId: resp.data.file_id,
        downloadCode: resp.data.download_code,
      };
    } else {
      log.error(`事务提交失败：${resp.data.errmsg}`);
      return null;
    }
  } catch (err: any) {
    log.error(`事务提交异常：${err.message}`);
    return null;
  }
}

/**
 * 计算分块参数
 */
function calculateChunkParams(fileSize: number): { chunkSize: number; totalChunks: number } {
  // 根据文件大小动态调整分块大小
  let chunkSize = CHUNK_CONFIG.DEFAULT_CHUNK_SIZE;
  
  if (fileSize > 100 * 1024 * 1024) {
    // >100MB，使用最大分块 8MB
    chunkSize = CHUNK_CONFIG.MAX_CHUNK_SIZE;
  } else if (fileSize > 50 * 1024 * 1024) {
    // >50MB，使用 6MB 分块
    chunkSize = 6 * 1024 * 1024;
  }
  
  const totalChunks = Math.ceil(fileSize / chunkSize);
  return { chunkSize, totalChunks };
}

/**
 * 分块上传大文件（>20MB）
 * @param filePath 文件路径
 * @param mediaType 媒体类型：video, file
 * @param oapiToken 钉钉 access_token
 * @param log 日志对象
 * @returns download_code 或 null
 */
export async function uploadLargeFileByChunks(
  filePath: string,
  mediaType: 'video' | 'file',
  oapiToken: string,
  debug: boolean = false,
): Promise<string | null> {
  const log = createLogger(debug, 'DingTalk][ChunkUpload');
  
  try {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
      log.warn(`文件不存在：${absPath}`);
      return null;
    }

    const stats = fs.statSync(absPath);
    const fileSize = stats.size;
    const fileName = path.basename(absPath);
    const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);

    log.info(`开始分块上传：${fileName}, 大小：${fileSizeMB}MB, 类型：${mediaType}`);

    // 步骤一：开启上传事务
    const uploadId = await enableUploadTransaction(oapiToken, fileName, fileSize, debug);
    if (!uploadId) {
      log.error(`开启事务失败，终止上传`);
      return null;
    }

    // 计算分块参数
    const { chunkSize, totalChunks } = calculateChunkParams(fileSize);
    log.info(`分块参数：chunkSize=${(chunkSize / 1024 / 1024).toFixed(2)}MB, totalChunks=${totalChunks}`);

    // 步骤二：分块上传
    const fileBuffer = fs.readFileSync(absPath);
    let successCount = 0;

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, fileSize);
      const chunkData = fileBuffer.slice(start, end);

      const success = await uploadFileBlock(
        oapiToken,
        uploadId,
        chunkData,
        i + 1, // chunkNumber 从 1 开始
        totalChunks,
        debug
      );

      if (!success) {
        log.error(`块 ${i + 1} 上传失败，终止上传`);
        return null;
      }

      successCount++;
      log.info(`进度：${successCount}/${totalChunks} (${((successCount / totalChunks) * 100).toFixed(1)}%)`);
    }

    // 步骤三：提交上传事务
    const result = await submitUploadTransaction(oapiToken, uploadId, fileName, debug);
    if (!result || !result.downloadCode) {
      log.error(`提交事务失败`);
      return null;
    }

    log.info(`分块上传完成：${fileName}, download_code: ${result.downloadCode}`);
    return result.downloadCode;
  } catch (err: any) {
    log.error(`分块上传异常：${err.message}`);
    return null;
  }
}
