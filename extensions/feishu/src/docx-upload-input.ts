import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { getFeishuRuntime } from "./runtime.js";

type RemoteMediaReader = (url: string, maxBytes: number) => Promise<{ buffer: Buffer }>;

export async function readRemoteDocxImage(
  url: string,
  maxBytes: number,
  imageReadTimeoutMs: number,
) {
  return await getFeishuRuntime().channel.media.readRemoteMediaBuffer({
    url,
    maxBytes,
    responseHeaderTimeoutMs: imageReadTimeoutMs,
    readIdleTimeoutMs: imageReadTimeoutMs,
  });
}

export async function readRemoteDocxFile(url: string, maxBytes: number) {
  return await getFeishuRuntime().channel.media.readRemoteMediaBuffer({ url, maxBytes });
}

export async function resolveDocxUploadInput(
  url: string | undefined,
  filePath: string | undefined,
  maxBytes: number,
  localRoots: readonly string[] | undefined,
  explicitFileName: string | undefined,
  readRemoteUrl: RemoteMediaReader,
  imageInput?: string,
): Promise<{ buffer: Buffer; fileName: string }> {
  const inputSources = (
    [url ? "url" : null, filePath ? "file_path" : null, imageInput ? "image" : null] as (
      | string
      | null
    )[]
  ).filter(Boolean);
  if (inputSources.length > 1) {
    throw new Error(`Provide only one image source; got: ${inputSources.join(", ")}`);
  }

  if (imageInput?.startsWith("data:")) {
    const commaIdx = imageInput.indexOf(",");
    if (commaIdx === -1) {
      throw new Error("Invalid data URI: missing comma separator.");
    }
    const header = imageInput.slice(0, commaIdx);
    const data = imageInput.slice(commaIdx + 1);
    if (!header.includes(";base64")) {
      throw new Error(
        `Invalid data URI: missing ';base64' marker. ` +
          `Expected format: data:image/png;base64,<base64data>`,
      );
    }
    const trimmedData = data.trim();
    if (trimmedData.length === 0 || !/^[A-Za-z0-9+/]+=*$/.test(trimmedData)) {
      throw new Error(
        `Invalid data URI: base64 payload contains characters outside the standard alphabet.`,
      );
    }
    const mimeMatch = header.match(/data:([^;]+)/);
    const ext = extensionForMime(mimeMatch?.[1])?.slice(1) ?? "png";
    const estimatedBytes = Math.ceil((trimmedData.length * 3) / 4);
    if (estimatedBytes > maxBytes) {
      throw new Error(
        `Image data URI exceeds limit: estimated ${estimatedBytes} bytes > ${maxBytes} bytes`,
      );
    }
    const buffer = Buffer.from(trimmedData, "base64");
    return { buffer, fileName: explicitFileName ?? `image.${ext}` };
  }

  // Explicit local path prefixes take precedence over plain base64 input.
  if (imageInput) {
    const candidate = imageInput.startsWith("~") ? imageInput.replace(/^~/, homedir()) : imageInput;
    const unambiguousPath =
      imageInput.startsWith("~") || imageInput.startsWith("./") || imageInput.startsWith("../");
    const absolutePath = isAbsolute(imageInput);

    if (unambiguousPath || (absolutePath && existsSync(candidate))) {
      const resolvedPath = resolve(candidate);
      const loaded = await getFeishuRuntime().media.loadWebMedia(resolvedPath, {
        maxBytes,
        optimizeImages: false,
        localRoots,
      });
      return { buffer: loaded.buffer, fileName: explicitFileName ?? basename(candidate) };
    }

    if (absolutePath && !existsSync(candidate)) {
      throw new Error(
        `File not found: "${candidate}". ` +
          `If you intended to pass image binary data, use a data URI instead: data:image/jpeg;base64,...`,
      );
    }
  }

  if (imageInput) {
    const trimmed = imageInput.trim();
    if (trimmed.length === 0 || !/^[A-Za-z0-9+/]+=*$/.test(trimmed)) {
      throw new Error(
        `Invalid base64: image input contains characters outside the standard base64 alphabet. ` +
          `Use a data URI (data:image/png;base64,...) or a local file path instead.`,
      );
    }
    const estimatedBytes = Math.ceil((trimmed.length * 3) / 4);
    if (estimatedBytes > maxBytes) {
      throw new Error(
        `Base64 image exceeds limit: estimated ${estimatedBytes} bytes > ${maxBytes} bytes`,
      );
    }
    const buffer = Buffer.from(trimmed, "base64");
    if (buffer.length === 0) {
      throw new Error("Base64 image decoded to empty buffer; check the input.");
    }
    return { buffer, fileName: explicitFileName ?? "image.png" };
  }

  if (!url && !filePath) {
    throw new Error("Either url, file_path, or image (base64/data URI) must be provided");
  }
  if (url && filePath) {
    throw new Error("Provide only one of url or file_path");
  }

  if (url) {
    const fetched = await readRemoteUrl(url, maxBytes);
    const urlPath = new URL(url).pathname;
    const guessed = urlPath.split("/").pop() || "upload.bin";
    return {
      buffer: fetched.buffer,
      fileName: explicitFileName || guessed,
    };
  }

  const resolvedFilePath = resolve(filePath!);
  const loaded = await getFeishuRuntime().media.loadWebMedia(resolvedFilePath, {
    maxBytes,
    optimizeImages: false,
    localRoots,
  });
  return {
    buffer: loaded.buffer,
    fileName: explicitFileName || basename(filePath!),
  };
}
