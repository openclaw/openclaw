import { getMatrixRuntime } from "../../runtime.js";
async function fetchMatrixMediaBuffer(params) {
  const url = params.client.mxcToHttp(params.mxcUrl);
  if (!url) {
    return null;
  }
  try {
    const result = await params.client.downloadContent(params.mxcUrl);
    const raw = result.data ?? result;
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (buffer.byteLength > params.maxBytes) {
      throw new Error("Matrix media exceeds configured size limit");
    }
    return { buffer, headerType: result.contentType };
  } catch (err) {
    throw new Error(`Matrix media download failed: ${String(err)}`, { cause: err });
  }
}
async function fetchEncryptedMediaBuffer(params) {
  if (!params.client.crypto) {
    throw new Error("Cannot decrypt media: crypto not enabled");
  }
  const decrypted = await params.client.crypto.decryptMedia(
    params.file
  );
  if (decrypted.byteLength > params.maxBytes) {
    throw new Error("Matrix media exceeds configured size limit");
  }
  return { buffer: decrypted };
}
async function downloadMatrixMedia(params) {
  let fetched;
  if (typeof params.sizeBytes === "number" && params.sizeBytes > params.maxBytes) {
    throw new Error("Matrix media exceeds configured size limit");
  }
  if (params.file) {
    fetched = await fetchEncryptedMediaBuffer({
      client: params.client,
      file: params.file,
      maxBytes: params.maxBytes
    });
  } else {
    fetched = await fetchMatrixMediaBuffer({
      client: params.client,
      mxcUrl: params.mxcUrl,
      maxBytes: params.maxBytes
    });
  }
  if (!fetched) {
    return null;
  }
  const headerType = fetched.headerType ?? params.contentType ?? void 0;
  const saved = await getMatrixRuntime().channel.media.saveMediaBuffer(
    fetched.buffer,
    headerType,
    "inbound",
    params.maxBytes
  );
  return {
    path: saved.path,
    contentType: saved.contentType,
    placeholder: "[matrix media]"
  };
}
export {
  downloadMatrixMedia
};
