// Log substring assertion helper for onboard E2E scenarios.
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const LOG_SCAN_CHUNK_BYTES = 64 * 1024;

const normalizeScriptOutput = (value) => value.replace(/\r?\n/g, "").replace(/\r/g, "");
const oscPattern = new RegExp(String.raw`\u001b\][^\u0007]*(?:\u0007|\u001b\\)`, "g");
const csiPattern = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "g");

const stripAnsi = (value) =>
  normalizeScriptOutput(value).replace(oscPattern, "").replace(csiPattern, "");

const compact = (value) =>
  stripAnsi(value)
    .toLowerCase()
    .replace(/[^a-z]+/g, "");

export function logContains(file, needle) {
  const compactNeedle = compact(needle);
  if (!compactNeedle) {
    return false;
  }
  const stats = fs.statSync(file);
  if (!stats.isFile()) {
    throw new Error(`${file} is not a file`);
  }

  const buffer = Buffer.alloc(LOG_SCAN_CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");
  const fd = fs.openSync(file, "r");
  let ansiState = "plain";
  let compactWindow = "";

  const scan = (text) => {
    for (const character of text) {
      if (ansiState === "osc") {
        if (character === "\u0007") {
          ansiState = "plain";
        } else if (character === "\u001b") {
          ansiState = "osc-escape";
        }
        continue;
      }
      if (ansiState === "osc-escape") {
        ansiState = character === "\\" || character === "\u0007" ? "plain" : "osc";
        continue;
      }
      if (ansiState === "csi") {
        if (character >= "@" && character <= "~") {
          ansiState = "plain";
        }
        continue;
      }
      if (ansiState === "escape") {
        if (character === "[") {
          ansiState = "csi";
          continue;
        }
        if (character === "]") {
          ansiState = "osc";
          continue;
        }
        ansiState = "plain";
      } else if (character === "\u001b") {
        ansiState = "escape";
        continue;
      }

      for (const lower of character.toLowerCase()) {
        if (lower < "a" || lower > "z") {
          continue;
        }
        compactWindow = `${compactWindow}${lower}`.slice(-compactNeedle.length);
        if (compactWindow === compactNeedle) {
          return true;
        }
      }
    }
    return false;
  };

  try {
    for (let position = 0; position < stats.size; position += LOG_SCAN_CHUNK_BYTES) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (scan(decoder.write(buffer.subarray(0, bytesRead)))) {
        return true;
      }
    }
    return scan(decoder.end());
  } finally {
    fs.closeSync(fd);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, needle] = process.argv.slice(2);
  if (!file || !needle) {
    process.exit(1);
  }

  try {
    process.exit(logContains(file, needle) ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
