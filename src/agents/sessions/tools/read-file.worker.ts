import { serialize } from "node:v8";
import { readRegularFile } from "@openclaw/fs-safe/advanced";
import type { ReadFilePage, ReadFilePageParams } from "./read-file-page.js";

export type FileReadResult = ReadFilePage | { error: Error; code?: string };

let result: FileReadResult;
try {
  const filePath = process.argv[2];
  if (!filePath) {
    throw new Error("File read requires a path");
  }
  if (process.argv[3] === "page") {
    const { captureReadFilePage } = await import("./read-file-page.js");
    const params: ReadFilePageParams = JSON.parse(process.argv[4]!);
    result = await captureReadFilePage(filePath, params);
  } else {
    result = { buffer: (await readRegularFile({ filePath })).buffer };
  }
} catch (error) {
  result = {
    error: error instanceof Error ? error : new Error(String(error)),
    ...(error instanceof Error && "code" in error && typeof error.code === "string"
      ? { code: error.code }
      : {}),
  };
}
process.stdout.write(serialize(result));
