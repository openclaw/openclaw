/**
 * 图片尺寸工具
 * 用于获取图片尺寸，生成 QQBot 的 markdown 图片格式
 *
 * QQBot markdown 图片格式: ![#宽px #高px](url)
 */

import { Buffer } from "buffer";

export interface ImageSize {
  width: number;
  height: number;
}

/** 默认图片尺寸（当无法获取时使用） */
export const DEFAULT_IMAGE_SIZE: ImageSize = { width: 512, height: 512 };

/**
 * 从 PNG 文件头解析图片尺寸
 * PNG 文件头结构: 前 8 字节是签名，IHDR 块从第 8 字节开始
 * IHDR 块: 长度(4) + 类型(4, "IHDR") + 宽度(4) + 高度(4) + ...
 */
function parsePngSize(buffer: Buffer): ImageSize | null {
  // PNG 签名: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.length < 24) return null;
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
    return null;
  }
  // IHDR 块从第 8 字节开始，宽度在第 16-19 字节，高度在第 20-23 字节
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

/**
 * 从 JPEG 文件解析图片尺寸
 * JPEG 尺寸在 SOF0/SOF2 块中
 */
function parseJpegSize(buffer: Buffer): ImageSize | null {
  // JPEG 签名: FF D8 FF
  if (buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset < buffer.length - 9) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = buffer[offset + 1];
    // SOF0 (0xC0) 或 SOF2 (0xC2) 包含图片尺寸
    if (marker === 0xc0 || marker === 0xc2) {
      // 格式: FF C0 长度(2) 精度(1) 高度(2) 宽度(2)
      if (offset + 9 <= buffer.length) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return { width, height };
      }
    }

    // 跳过当前块
    if (offset + 3 < buffer.length) {
      const blockLength = buffer.readUInt16BE(offset + 2);
      offset += 2 + blockLength;
    } else {
      break;
    }
  }

  return null;
}

/**
 * 从 GIF 文件头解析图片尺寸
 * GIF 文件头: GIF87a 或 GIF89a (6字节) + 宽度(2) + 高度(2)
 */
function parseGifSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 10) return null;
  const signature = buffer.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") {
    return null;
  }
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  return { width, height };
}

/**
 * 从 WebP 文件解析图片尺寸
 * WebP 文件头: RIFF(4) + 文件大小(4) + WEBP(4) + VP8/VP8L/VP8X(4) + ...
 */
function parseWebpSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 30) return null;

  // 检查 RIFF 和 WEBP 签名
  const riff = buffer.toString("ascii", 0, 4);
  const webp = buffer.toString("ascii", 8, 12);
  if (riff !== "RIFF" || webp !== "WEBP") {
    return null;
  }

  const chunkType = buffer.toString("ascii", 12, 16);

  // VP8 (有损压缩)
  if (chunkType === "VP8 ") {
    // VP8 帧头从第 23 字节开始，检查签名 9D 01 2A
    if (buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      const width = buffer.readUInt16LE(26) & 0x3fff;
      const height = buffer.readUInt16LE(28) & 0x3fff;
      return { width, height };
    }
  }

  // VP8L (无损压缩)
  if (chunkType === "VP8L") {
    // VP8L 签名: 0x2F
    if (buffer.length >= 25 && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { width, height };
    }
  }

  // VP8X (扩展格式)
  if (chunkType === "VP8X") {
    if (buffer.length >= 30) {
      // 宽度和高度在第 24-26 和 27-29 字节（24位小端）
      const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
      const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
      return { width, height };
    }
  }

  return null;
}

/**
 * 从图片数据 Buffer 解析尺寸
 */
export function parseImageSize(buffer: Buffer): ImageSize | null {
  // 尝试各种格式
  return (
    parsePngSize(buffer) ?? parseJpegSize(buffer) ?? parseGifSize(buffer) ?? parseWebpSize(buffer)
  );
}

/**
 * 从公网 URL 获取图片尺寸
 * 只下载前 64KB 数据，足够解析大部分图片格式的头部
 */
export async function getImageSizeFromUrl(
  url: string,
  timeoutMs = 5000,
): Promise<ImageSize | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // 使用 Range 请求只获取前 64KB
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Range: "bytes=0-65535",
        "User-Agent": "QQBot-Image-Size-Detector/1.0",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok && response.status !== 206) {
      console.log(`[image-size] Failed to fetch ${url}: ${response.status}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const size = parseImageSize(buffer);
    if (size) {
      console.log(
        `[image-size] Got size from URL: ${size.width}x${size.height} - ${url.slice(0, 60)}...`,
      );
    }

    return size;
  } catch (err) {
    console.log(`[image-size] Error fetching ${url.slice(0, 60)}...: ${err}`);
    return null;
  }
}

/**
 * 从 Base64 Data URL 获取图片尺寸
 */
export function getImageSizeFromDataUrl(dataUrl: string): ImageSize | null {
  try {
    // 格式: data:image/png;base64,xxxxx
    const matches = dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
    if (!matches) {
      return null;
    }

    const base64Data = matches[1];
    const buffer = Buffer.from(base64Data, "base64");

    const size = parseImageSize(buffer);
    if (size) {
      console.log(`[image-size] Got size from Base64: ${size.width}x${size.height}`);
    }

    return size;
  } catch (err) {
    console.log(`[image-size] Error parsing Base64: ${err}`);
    return null;
  }
}

/**
 * 获取图片尺寸（自动判断来源）
 * @param source - 图片 URL 或 Base64 Data URL
 * @returns 图片尺寸，失败返回 null
 */
export async function getImageSize(source: string): Promise<ImageSize | null> {
  if (source.startsWith("data:")) {
    return getImageSizeFromDataUrl(source);
  }

  if (source.startsWith("http://") || source.startsWith("https://")) {
    return getImageSizeFromUrl(source);
  }

  return null;
}

/**
 * 生成 QQBot markdown 图片格式
 * 格式: ![#宽px #高px](url)
 *
 * @param url - 图片 URL
 * @param size - 图片尺寸，如果为 null 则使用默认尺寸
 * @returns QQBot markdown 图片字符串
 */
export function formatQQBotMarkdownImage(url: string, size: ImageSize | null): string {
  const { width, height } = size ?? DEFAULT_IMAGE_SIZE;
  return `![#${width}px #${height}px](${url})`;
}

/**
 * 检查 markdown 图片是否已经包含 QQBot 格式的尺寸信息
 * 格式: ![#宽px #高px](url)
 */
export function hasQQBotImageSize(markdownImage: string): boolean {
  return /!\[#\d+px\s+#\d+px\]/.test(markdownImage);
}

/**
 * 从已有的 QQBot 格式 markdown 图片中提取尺寸
 * 格式: ![#宽px #高px](url)
 */
export function extractQQBotImageSize(markdownImage: string): ImageSize | null {
  const match = markdownImage.match(/!\[#(\d+)px\s+#(\d+)px\]/);
  if (match) {
    return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
  }
  return null;
}
