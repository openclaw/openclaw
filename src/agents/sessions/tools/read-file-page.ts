import { basename, dirname } from "node:path";
import { root } from "@openclaw/fs-safe";
import { readFileWindowFully } from "@openclaw/fs-safe/advanced";
import { classifyAttachmentBytes } from "@openclaw/media-core/attachment-classify";
import { FILE_TYPE_SNIFF_MAX_BYTES } from "@openclaw/media-core/mime";
import { createWindowsTextFileDecoder } from "../../../infra/windows-encoding.js";
import { detectSupportedImageMimeType } from "../../utils/mime.js";
import { createReadTextCapture, type ReadTextCapture } from "./read-text-capture.js";
import { DEFAULT_MAX_LINES } from "./truncate.js";

export type ReadFilePageParams = Pick<
  Parameters<typeof createReadTextCapture>[0],
  "offset" | "cursor" | "limit" | "maxChars"
>;
export type ReadFilePage = { buffer: Buffer; text?: ReadTextCapture };

/** Runs in the admitted reader process, never opening a state-file handle in the Gateway. */
export async function captureReadFilePage(
  filePath: string,
  params: ReadFilePageParams,
  signal?: AbortSignal,
): Promise<ReadFilePage> {
  signal?.throwIfAborted();
  const directory = await root(dirname(filePath));
  const opened = await directory.open(basename(filePath), {
    symlinks: "follow-parents-within-root",
    hardlinks: "allow",
  });
  try {
    // Virtual files can report zero or stale sizes; only a read establishes EOF.
    const prefix = Buffer.allocUnsafe(FILE_TYPE_SNIFF_MAX_BYTES);
    const count = await readFileWindowFully(opened.handle, prefix, 0, { signal });
    const buffer = prefix.subarray(0, count);
    if (buffer.length < FILE_TYPE_SNIFF_MAX_BYTES) {
      return { buffer };
    }
    const mime = detectSupportedImageMimeType(buffer);
    const attachment = mime ? undefined : await classifyAttachmentBytes({ buffer });
    if (mime || attachment?.class === "image") {
      return { buffer: await opened.handle.readFile() };
    }
    if (attachment?.class === "document") {
      return { buffer };
    }
    const decoder = createWindowsTextFileDecoder({ prefix: buffer, complete: false });
    const selected = createReadTextCapture({
      ...params,
      stopEarly: true,
      maxLines: DEFAULT_MAX_LINES,
    });
    let firstText = true;
    const decode = (chunk?: Buffer) => {
      let text = decoder.decode(chunk, chunk === undefined ? undefined : { stream: true });
      if (firstText && text.length > 0) {
        firstText = false;
        text = text.startsWith("\uFEFF") ? text.slice(1) : text;
      }
      return selected.write(text);
    };
    let position = 0;
    let complete = true;
    const window = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      signal?.throwIfAborted();
      const chunk =
        position < buffer.length
          ? buffer.subarray(position, Math.min(position + 64 * 1024, buffer.length))
          : window.subarray(
              0,
              await readFileWindowFully(opened.handle, window, position, { signal }),
            );
      if (chunk.length === 0) {
        decode();
        break;
      }
      position += chunk.length;
      if (!decode(chunk)) {
        complete = false;
        break;
      }
    }
    return { buffer, text: selected.finish(complete) };
  } finally {
    await opened.handle.close();
  }
}
