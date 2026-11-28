import { createHash } from "node:crypto";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const SCREENSHOT_MEDIA_TYPE = "application/vnd.openclaw.beam.screenshot+json";
export const MAX_SCREENSHOT_BYTES = 512 * 1024;
export type BeamScreenshot = { name: string; png: string; digest: string };

export function readScreenshotEnvelope(raw: Buffer): { packet: Buffer; image: BeamScreenshot } {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    typeof value.packet !== "string" ||
    typeof value.name !== "string" ||
    !value.name ||
    value.name === "." ||
    value.name === ".." ||
    Buffer.byteLength(value.name) > 255 ||
    value.name !== value.name.toWellFormed() ||
    /[/\\\p{Cc}\p{Cf}]/u.test(value.name) ||
    typeof value.png !== "string" ||
    value.png.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4
  ) {
    throw new Error("Invalid screenshot envelope");
  }
  const bytes = Buffer.from(value.png, "base64");
  if (
    bytes.toString("base64") !== value.png ||
    bytes.length < 45 ||
    bytes.length > MAX_SCREENSHOT_BYTES ||
    bytes.subarray(0, 16).toString("hex") !== "89504e470d0a1a0a0000000d49484452" ||
    bytes.subarray(-12).toString("hex") !== "0000000049454e44ae426082"
  ) {
    throw new Error("Expected a bounded PNG");
  }
  const pixels = bytes.readUInt32BE(16) * bytes.readUInt32BE(20);
  if (pixels < 1 || pixels > 16_777_216) {
    throw new Error("Invalid screenshot dimensions");
  }
  const digest =
    "sha256:" +
    createHash("sha256").update(value.name).update(Buffer.of(0)).update(bytes).digest("hex");
  return { packet: Buffer.from(value.packet), image: { name: value.name, png: value.png, digest } };
}
