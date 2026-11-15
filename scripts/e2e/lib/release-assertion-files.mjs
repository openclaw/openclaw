// Shared bounded file readers for release E2E assertion scripts.
import fs from "node:fs";
import { readTextFileTail, textFileContains as fileContainsText } from "./text-file-utils.mjs";

export { fileContainsText };

const ERROR_DETAIL_TAIL_BYTES = 16 * 1024;
const JSON_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;

export function readJson(file, maxBytes = JSON_ARTIFACT_MAX_BYTES) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) {
    throw new Error(`${file} is not a file`);
  }
  if (stat.size > maxBytes) {
    throw new Error(
      `JSON artifact exceeded ${maxBytes} bytes: ${file} (${stat.size} bytes). Tail: ${readTextFileTail(
        file,
        ERROR_DETAIL_TAIL_BYTES,
      )}`,
    );
  }
  const text = fs.readFileSync(file, "utf8");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new Error(
      `JSON artifact exceeded ${maxBytes} bytes: ${file} (${bytes} bytes). Tail: ${readTextFileTail(
        file,
        ERROR_DETAIL_TAIL_BYTES,
      )}`,
    );
  }
  return JSON.parse(text);
}

export function assertFileContainsText(file, needle, callerAssert) {
  callerAssert(
    fileContainsText(file, needle),
    `${file} did not contain ${needle}. Output tail: ${readTextFileTail(file, ERROR_DETAIL_TAIL_BYTES)}`,
  );
}
