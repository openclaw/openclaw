import fs from "node:fs/promises";
import path from "node:path";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeHostCommandAvailabilityContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { asFiniteNumber as readFiniteNumber } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { clamp } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  assertToolResult,
  formatToolError,
  isCapabilityEnabledForHost,
  parseParams,
} from "./command-utils.js";
import type { ResolvedLinuxNodePluginConfig } from "./config.js";
import { resolveExecutable } from "./executables.js";

const GEOCLUE_DEMO_PATHS = [
  "/usr/libexec/geoclue-2.0/demos/where-am-i",
  "/usr/lib/geoclue-2.0/demos/where-am-i",
];
const GEOCLUE_TIMESTAMP_RESOLUTION_MS = 1000;

function isLocationDisabledOutput(output: string): boolean {
  // GeoClue reports both an explicit disable and, on headless hosts without an
  // authorization agent, an access-denied error; both mean "not permitted here".
  return /Geolocation disabled|disallowed, no agent|AccessDenied|not authorized/iu.test(output);
}

function parseLocationOutput(
  output: string,
  maxAgeMs?: number,
): {
  lat: number;
  lon: number;
  accuracyMeters: number;
  altitudeMeters?: number;
  speedMps?: number;
  headingDeg?: number;
  timestamp: string;
} | null {
  const blocks = output.split(/\nNew location:\s*\n/gu);
  for (const block of blocks.toReversed()) {
    const latitude = /Latitude:\s*([-+\d.]+)/u.exec(block)?.[1];
    const longitude = /Longitude:\s*([-+\d.]+)/u.exec(block)?.[1];
    const accuracy = /Accuracy:\s*([-+\d.]+)/u.exec(block)?.[1];
    if (latitude === undefined || longitude === undefined || accuracy === undefined) {
      continue;
    }
    const lat = Number(latitude);
    const lon = Number(longitude);
    const accuracyMeters = Number(accuracy);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !Number.isFinite(accuracyMeters) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180 ||
      accuracyMeters < 0
    ) {
      continue;
    }
    const epochSeconds = /\((\d+)\s+seconds since the Epoch\)/u.exec(block)?.[1];
    const altitude = /Altitude:\s*([-+\d.]+)/u.exec(block)?.[1];
    const speed = /Speed:\s*([-+\d.]+)/u.exec(block)?.[1];
    const heading = /Heading:\s*([-+\d.]+)/u.exec(block)?.[1];
    const timestamp = epochSeconds
      ? new Date(Number(epochSeconds) * 1000).toISOString()
      : new Date().toISOString();
    const ageMs = Date.now() - Date.parse(timestamp);
    if (
      maxAgeMs !== undefined &&
      (ageMs < 0 || ageMs >= maxAgeMs + GEOCLUE_TIMESTAMP_RESOLUTION_MS)
    ) {
      continue;
    }
    return {
      lat,
      lon,
      accuracyMeters,
      ...(altitude !== undefined ? { altitudeMeters: Number(altitude) } : {}),
      ...(speed !== undefined ? { speedMps: Number(speed) } : {}),
      ...(heading !== undefined ? { headingDeg: Number(heading) } : {}),
      timestamp,
    };
  }
  return null;
}

const MAX_GATEWAY_PAYLOAD_BYTES = 25 * 1024 * 1024;
// The base64 field sits inside payloadJSON and the node.invoke response frame.
const MAX_GATEWAY_ENVELOPE_BYTES = 64 * 1024;
const MAX_BASE64_BYTES = MAX_GATEWAY_PAYLOAD_BYTES - MAX_GATEWAY_ENVELOPE_BYTES;
const MAX_MEDIA_RAW_BYTES = Math.floor(MAX_BASE64_BYTES / 4) * 3;

type VideoDevice = {
  id: string;
  name: string;
  position: "unknown";
  deviceType: "v4l2";
};

function encodeMedia(buffer: Buffer): string {
  if (buffer.byteLength > MAX_MEDIA_RAW_BYTES) {
    throw new Error("PAYLOAD_TOO_LARGE: camera payload exceeds the 25 MB base64 limit");
  }
  return buffer.toString("base64");
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.byteLength < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 9 < buffer.byteLength) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === undefined) {
      return null;
    }
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      return null;
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && segmentLength >= 7) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    if (segmentLength < 2) {
      return null;
    }
    offset += segmentLength + 2;
  }
  return null;
}

async function listLinuxVideoDevices(ffmpeg: string): Promise<VideoDevice[]> {
  const entries = await fs.readdir("/dev");
  const deviceNames = entries
    .filter((entry) => /^video\d+$/u.test(entry))
    .toSorted((left, right) => left.localeCompare(right, "en", { numeric: true }));
  const devices: VideoDevice[] = [];
  for (const entry of deviceNames) {
    const id = path.join("/dev", entry);
    const probe = await runCommandWithTimeout(
      [ffmpeg, "-hide_banner", "-f", "v4l2", "-list_formats", "all", "-i", id],
      {
        timeoutMs: 5000,
        maxOutputBytes: { stdout: 4096, stderr: 64 * 1024 },
        outputCapture: "tail",
      },
    );
    // FFmpeg intentionally exits after listing formats. Format rows prove the
    // node supports video capture; the process exit code does not.
    if (!/\b(?:Raw|Compressed)\s*:/u.test(`${probe.stdout}\n${probe.stderr}`)) {
      continue;
    }
    // The sysfs label is cosmetic; a successful capture probe already identified the device.
    const name = await fs
      .readFile(path.join("/sys/class/video4linux", entry, "name"), "utf8")
      .then((value) => value.trim())
      .catch(() => entry);
    devices.push({ id, name, position: "unknown", deviceType: "v4l2" });
  }
  return devices;
}

async function withTempFile<T>(suffix: string, run: (filePath: string) => Promise<T>): Promise<T> {
  return await withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-linux-node-" },
    async ({ dir }) => await run(path.join(dir, `capture${suffix}`)),
  );
}

export function createLinuxNodeCommands(
  config: ResolvedLinuxNodePluginConfig,
): OpenClawPluginNodeHostCommand[] {
  const platform = process.platform;
  const env = process.env;
  const findWhereAmI = (searchEnv = env) =>
    resolveExecutable("where-am-i", searchEnv, GEOCLUE_DEMO_PATHS);

  const readMedia = async (filePath: string) => {
    if ((await fs.stat(filePath)).size > MAX_MEDIA_RAW_BYTES) {
      throw new Error("PAYLOAD_TOO_LARGE: camera payload exceeds the 25 MB base64 limit");
    }
    return await fs.readFile(filePath);
  };
  const assertLinuxCapability = (capability: keyof ResolvedLinuxNodePluginConfig, code: string) => {
    if (platform !== "linux") {
      throw new Error(`${code}: Linux node host required`);
    }
    if (!config[capability].enabled) {
      throw new Error(
        `${code}: enable plugins.entries.linux-node.config.${capability}.enabled and restart the node service`,
      );
    }
  };
  const isAvailable =
    (capability: keyof ResolvedLinuxNodePluginConfig, tool: "ffmpeg" | "notify-send") =>
    (context: OpenClawPluginNodeHostCommandAvailabilityContext) =>
      platform === "linux" &&
      isCapabilityEnabledForHost(context, capability) &&
      resolveExecutable(tool, context.env) !== null;
  const resolveTool = (
    capability: keyof ResolvedLinuxNodePluginConfig,
    tool: "ffmpeg" | "notify-send",
    disabledCode: string,
    unavailableCode: string,
  ) => {
    assertLinuxCapability(capability, disabledCode);
    const executable = resolveExecutable(tool, env);
    if (!executable) {
      throw new Error(`${unavailableCode}: ${tool} not found`);
    }
    return executable;
  };
  const selectVideoDevice = async (deviceId: unknown, ffmpeg: string) => {
    const devices = await listLinuxVideoDevices(ffmpeg);
    if (typeof deviceId === "string" && deviceId.trim()) {
      const match = devices.find((device) => device.id === deviceId.trim());
      if (!match) {
        throw new Error(`INVALID_REQUEST: camera device not found: ${deviceId.trim()}`);
      }
      return match;
    }
    const device = devices[0];
    if (!device) {
      throw new Error("CAMERA_UNAVAILABLE: no V4L2 camera devices found");
    }
    return device;
  };

  return [
    {
      command: "system.notify",
      hasActiveWork: () => false,
      isAvailable: isAvailable("notify", "notify-send"),
      handle: async (paramsJSON) => {
        const notifySend = resolveTool(
          "notify",
          "notify-send",
          "NOTIFICATIONS_DISABLED",
          "NOTIFICATIONS_UNAVAILABLE",
        );
        const params = parseParams(paramsJSON);
        const title = typeof params.title === "string" ? params.title.trim() : "";
        const body = typeof params.body === "string" ? params.body.trim() : "";
        if (!title && !body) {
          throw new Error("INVALID_REQUEST: empty notification");
        }
        const urgency =
          params.priority === "passive"
            ? "low"
            : params.priority === "timeSensitive"
              ? "critical"
              : "normal";
        const result = await runCommandWithTimeout(
          [notifySend, "--urgency", urgency, "--", title, body],
          {
            timeoutMs: 10_000,
          },
        );
        assertToolResult(result, "NOTIFICATIONS_UNAVAILABLE");
        return JSON.stringify({ ok: true });
      },
    },
    {
      command: "camera.list",
      hasActiveWork: () => false,
      cap: "camera",
      isAvailable: isAvailable("camera", "ffmpeg"),
      handle: async () => {
        const ffmpeg = resolveTool("camera", "ffmpeg", "CAMERA_DISABLED", "CAMERA_UNAVAILABLE");
        return JSON.stringify({ devices: await listLinuxVideoDevices(ffmpeg) });
      },
    },
    {
      command: "camera.snap",
      hasActiveWork: () => false,
      cap: "camera",
      dangerous: true,
      isAvailable: isAvailable("camera", "ffmpeg"),
      handle: async (paramsJSON) => {
        const ffmpeg = resolveTool("camera", "ffmpeg", "CAMERA_DISABLED", "CAMERA_UNAVAILABLE");
        const params = parseParams(paramsJSON);
        const format = typeof params.format === "string" ? params.format.toLowerCase() : "jpg";
        if (format !== "jpg" && format !== "jpeg") {
          throw new Error(`INVALID_REQUEST: unsupported camera image format: ${format}`);
        }
        const device = await selectVideoDevice(params.deviceId, ffmpeg);
        const maxWidthRaw = readFiniteNumber(params.maxWidth);
        // Honor small downscale requests, but floor to 2 so the proportional `-2`
        // height in the scale filter never rounds to a non-positive dimension.
        const maxWidth =
          maxWidthRaw && maxWidthRaw > 0 ? Math.max(2, Math.floor(maxWidthRaw)) : 1600;
        const quality = clamp(readFiniteNumber(params.quality) ?? 0.9, 0.05, 1);
        const delayMs = clamp(Math.floor(readFiniteNumber(params.delayMs) ?? 2000), 0, 10_000);
        const ffmpegQuality = Math.round(31 - quality * 29);
        return await withTempFile(".jpg", async (outputPath) => {
          const result = await runCommandWithTimeout(
            [
              ffmpeg,
              "-hide_banner",
              "-loglevel",
              "error",
              "-y",
              "-f",
              "v4l2",
              "-i",
              device.id,
              "-ss",
              (delayMs / 1000).toFixed(3),
              "-frames:v",
              "1",
              "-vf",
              `scale=min(iw\\,${maxWidth}):-2`,
              "-q:v",
              String(ffmpegQuality),
              outputPath,
            ],
            { timeoutMs: delayMs + 20_000 },
          );
          assertToolResult(result, "CAMERA_UNAVAILABLE");
          const image = await readMedia(outputPath);
          const dimensions = readJpegDimensions(image);
          if (!dimensions) {
            throw new Error("CAMERA_UNAVAILABLE: FFmpeg returned an invalid JPEG");
          }
          return JSON.stringify({
            format,
            base64: encodeMedia(image),
            width: dimensions.width,
            height: dimensions.height,
          });
        });
      },
    },
    {
      command: "camera.clip",
      hasActiveWork: () => false,
      cap: "camera",
      dangerous: true,
      isAvailable: isAvailable("camera", "ffmpeg"),
      handle: async (paramsJSON) => {
        const ffmpeg = resolveTool("camera", "ffmpeg", "CAMERA_DISABLED", "CAMERA_UNAVAILABLE");
        const params = parseParams(paramsJSON);
        const format = typeof params.format === "string" ? params.format.toLowerCase() : "mp4";
        if (format !== "mp4") {
          throw new Error(`INVALID_REQUEST: unsupported camera clip format: ${format}`);
        }
        const device = await selectVideoDevice(params.deviceId, ffmpeg);
        const durationMs = clamp(
          Math.floor(readFiniteNumber(params.durationMs) ?? 3000),
          250,
          60_000,
        );
        const includeAudio = typeof params.includeAudio === "boolean" ? params.includeAudio : true;
        return await withTempFile(".mp4", async (outputPath) => {
          const inputs = ["-f", "v4l2", "-i", device.id];
          if (includeAudio) {
            inputs.push("-f", "pulse", "-i", "default");
          }
          const audioArgs = includeAudio
            ? ["-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "128k", "-shortest"]
            : ["-an"];
          const result = await runCommandWithTimeout(
            [
              ffmpeg,
              "-hide_banner",
              "-loglevel",
              "error",
              "-y",
              ...inputs,
              "-t",
              (durationMs / 1000).toFixed(3),
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-pix_fmt",
              "yuv420p",
              ...audioArgs,
              "-movflags",
              "+faststart",
              outputPath,
            ],
            { timeoutMs: durationMs + 30_000 },
          );
          assertToolResult(result, "CAMERA_UNAVAILABLE");
          const clip = await readMedia(outputPath);
          return JSON.stringify({
            format: "mp4",
            base64: encodeMedia(clip),
            durationMs,
            hasAudio: includeAudio,
          });
        });
      },
    },
    {
      command: "location.get",
      hasActiveWork: () => false,
      cap: "location",
      isAvailable: (context) =>
        platform === "linux" &&
        isCapabilityEnabledForHost(context, "location") &&
        findWhereAmI(context.env) !== null,
      handle: async (paramsJSON) => {
        if (platform !== "linux") {
          throw new Error("LOCATION_DISABLED: Linux node host required");
        }
        if (!config.location.enabled) {
          throw new Error(
            "LOCATION_DISABLED: enable plugins.entries.linux-node.config.location.enabled and restart the node service",
          );
        }
        const whereAmI = findWhereAmI();
        if (!whereAmI) {
          throw new Error("LOCATION_UNAVAILABLE: where-am-i not found");
        }
        const params = parseParams(paramsJSON);
        const timeoutMs = clamp(
          Math.floor(readFiniteNumber(params.timeoutMs) ?? 10_000),
          1000,
          60_000,
        );
        const maxAgeMsRaw = readFiniteNumber(params.maxAgeMs);
        const maxAgeMs = maxAgeMsRaw !== undefined && maxAgeMsRaw >= 0 ? maxAgeMsRaw : undefined;
        const desiredAccuracy =
          params.desiredAccuracy === "coarse" ? 4 : params.desiredAccuracy === "precise" ? 8 : 6;
        let streamedOutput = "";
        let observedTimestamps = 0;
        const result = await runCommandWithTimeout(
          // where-am-i `-t` is "exit after T seconds" (a process timeout), not the
          // `-i` time-threshold (update throttle, default 0), so no fix is withheld.
          [whereAmI, "-t", String(Math.ceil(timeoutMs / 1000)), "-a", String(desiredAccuracy)],
          {
            timeoutMs: timeoutMs + 3000,
            maxOutputBytes: { stdout: 64 * 1024, stderr: 16 * 1024 },
            outputCapture: "tail",
            env: { LC_ALL: "C", LANG: "C" },
            onOutputChunk: (chunk, stream) => {
              if (stream !== "stdout") {
                return true;
              }
              streamedOutput = `${streamedOutput}${chunk.toString("utf8")}`.slice(-64 * 1024);
              if (isLocationDisabledOutput(streamedOutput)) {
                return false;
              }
              const timestampCount = [
                ...streamedOutput.matchAll(/Timestamp:\s*.*seconds since the Epoch\)/gu),
              ].length;
              if (timestampCount === observedTimestamps) {
                return true;
              }
              observedTimestamps = timestampCount;
              return parseLocationOutput(streamedOutput, maxAgeMs) === null;
            },
          },
        );
        const toolOutput = `${result.stdout}\n${result.stderr}\n${streamedOutput}`;
        if (isLocationDisabledOutput(toolOutput)) {
          throw new Error("LOCATION_DISABLED: GeoClue location services are disabled");
        }
        const location = parseLocationOutput(`${result.stdout}\n${streamedOutput}`, maxAgeMs);
        if (!location) {
          if (result.termination === "timeout" || result.code === 0) {
            throw new Error("LOCATION_TIMEOUT: no fix in time");
          }
          throw new Error(`LOCATION_UNAVAILABLE: ${formatToolError(result)}`);
        }
        return JSON.stringify({
          ...location,
          isPrecise: location.accuracyMeters <= 100,
          source: "unknown",
        });
      },
    },
  ];
}
