import path from "node:path";
import { Type } from "@sinclair/typebox";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginService,
} from "openclaw/plugin-sdk/insta360";
import { parseInsta360Config } from "./src/config.js";
import { downloadFile } from "./src/download.js";
import { RecordingMonitor } from "./src/monitor.js";
import { OscClient } from "./src/osc-client.js";
import { validateFileUrls, validateDownloadPath } from "./src/validation.js";

const ACTIONS = [
  "info",
  "status",
  "photo",
  "record_start",
  "record_stop",
  "settings",
  "list_files",
  "download",
  "delete",
] as const;

const VIDEO_TYPES = ["normal", "timelapse"] as const;
const STITCHING_MODES = ["none", "ondevice"] as const;
const WHITE_BALANCE_PRESETS = [
  "auto",
  "incandescent",
  "fluorescent",
  "daylight",
  "cloudy-daylight",
] as const;

function stringEnum<T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    description,
  });
}

const Insta360Schema = Type.Object({
  action: stringEnum(ACTIONS, `Camera action: ${ACTIONS.join(", ")}.`),
  hdr: Type.Optional(Type.Boolean({ description: "Enable HDR (photo only)." })),
  stitching: Type.Optional(stringEnum(STITCHING_MODES, "Photo stitching mode.")),
  videoType: Type.Optional(stringEnum(VIDEO_TYPES, "Video type for record_start.")),
  timelapseInterval: Type.Optional(
    Type.Number({ description: "Timelapse interval in seconds (0.2-120). Only for timelapse." }),
  ),
  options: Type.Optional(
    Type.Object(
      {
        iso: Type.Optional(Type.Number({ description: "ISO value." })),
        shutterSpeed: Type.Optional(Type.Number({ description: "Shutter speed." })),
        whiteBalance: Type.Optional(stringEnum(WHITE_BALANCE_PRESETS, "White balance preset.")),
        exposureProgram: Type.Optional(
          Type.Number({ description: "1=Manual, 2=Auto, 4=Shutter Priority, 9=ISO Priority." }),
        ),
      },
      { description: "Camera settings for the 'settings' action." },
    ),
  ),
  fileUrls: Type.Optional(
    Type.Array(Type.String(), { description: "File URLs for download/delete." }),
  ),
  count: Type.Optional(Type.Number({ description: "Number of files to list (default 10)." })),
});

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function text(msg: string) {
  return { content: [{ type: "text" as const, text: msg }] };
}

export default function register(api: OpenClawPluginApi) {
  const cfg = parseInsta360Config(api.pluginConfig);
  let client: OscClient | null = null;
  let monitor: RecordingMonitor | null = null;
  let initialized = false;

  function getClient(): OscClient {
    if (!client) {
      client = new OscClient(cfg.cameraHost);
    }
    return client;
  }

  function resolveDownloadDir(): string {
    if (cfg.downloadPath) {
      return api.resolvePath(cfg.downloadPath);
    }
    return api.resolvePath("~/.openclaw/plugins/insta360/media");
  }

  async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    const c = getClient();
    const { info } = await c.init();
    const manufacturer = (info.manufacturer as string) ?? "";
    if (!manufacturer.toLowerCase().includes("insta360")) {
      throw new Error(
        `Device at ${cfg.cameraHost} is not an Insta360 camera (manufacturer: ${manufacturer})`,
      );
    }
    initialized = true;
  }

  // --- Tool ---
  api.registerTool({
    name: "insta360_camera",
    label: "Insta360 Camera",
    description: [
      "Control an Insta360 camera via OSC protocol.",
      "Actions: info, status, photo, record_start, record_stop, settings, list_files, download, delete.",
      "For photo: optionally set hdr=true, stitching='ondevice'.",
      "For record_start: set videoType='timelapse' and timelapseInterval (0.2-120s) for timelapse.",
      "For settings: pass options object with iso, shutterSpeed, whiteBalance, exposureProgram.",
      "For download/delete: pass fileUrls array from list_files results.",
    ].join(" "),
    parameters: Insta360Schema,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const action = params.action as string;

      try {
        const c = getClient();

        switch (action) {
          case "info": {
            const info = await c.getInfo();
            return json(info);
          }

          case "status": {
            const state = await c.getState();
            return json(state);
          }

          case "photo": {
            await ensureInitialized();
            const setOpts: Record<string, unknown> = { captureMode: "image" };
            if (params.hdr) setOpts.hdr = "hdr";
            if (params.stitching) setOpts.photoStitching = params.stitching;
            await c.execute("camera.setOptions", { options: setOpts });
            const result = await c.executeAndWait("camera.takePicture");
            return json(result);
          }

          case "record_start": {
            await ensureInitialized();
            const videoType = (params.videoType as string) ?? "normal";
            const setOpts: Record<string, unknown> = {
              captureMode: "video",
              _videoType: videoType,
            };
            if (videoType === "timelapse" && typeof params.timelapseInterval === "number") {
              setOpts._timelapseInterval = params.timelapseInterval;
            }
            await c.execute("camera.setOptions", { options: setOpts });
            const result = await c.execute("camera.startCapture");

            // Start monitor — route alerts to logger (visible in gateway logs + UI)
            if (!monitor?.isRunning) {
              const sessionKey =
                typeof params._sessionKey === "string" ? params._sessionKey : "recording";
              monitor = new RecordingMonitor({
                client: c,
                onAlert: (msg) => api.logger.warn(`[insta360] ${msg}`),
                lowBatteryThreshold: cfg.lowBatteryThreshold,
                lowStorageMB: cfg.lowStorageMB,
                pollIntervalMs: cfg.pollIntervalMs,
              });
              monitor.start(sessionKey);
            }

            return json(result);
          }

          case "record_stop": {
            try {
              const result = await c.execute("camera.stopCapture");
              // Stop monitor only after capture successfully stopped
              monitor?.stop();
              return json(result);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (msg.includes("disabled") || msg.includes("not recording")) {
                monitor?.stop();
                return text("Recording already stopped.");
              }
              // Camera command failed — keep monitor running for disconnect alerts
              throw err;
            }
          }

          case "settings": {
            const options = params.options as Record<string, unknown> | undefined;
            if (!options || Object.keys(options).length === 0) {
              return text(
                "No settings provided. Pass options: { iso, shutterSpeed, whiteBalance, exposureProgram }",
              );
            }
            const result = await c.execute("camera.setOptions", { options });
            return json(result);
          }

          case "list_files": {
            await ensureInitialized();
            const count = typeof params.count === "number" ? params.count : 10;
            const result = await c.execute("camera.listFiles", {
              fileType: "all",
              entryCount: count,
              maxThumbSize: 0,
            });
            return json(result);
          }

          case "download": {
            await ensureInitialized();
            const urls = params.fileUrls as string[] | undefined;
            if (!urls?.length) return text("No fileUrls provided.");
            validateFileUrls(urls, cfg.cameraHost);
            const downloadDir = resolveDownloadDir();
            const results: { url: string; dest: string; bytes: number }[] = [];
            for (const url of urls) {
              const fileName = url.split("/").pop() ?? `file-${Date.now()}`;
              const destPath = path.join(downloadDir, fileName);
              validateDownloadPath(destPath, downloadDir);
              const r = await downloadFile(url, destPath);
              results.push({ url, dest: r.destPath, bytes: r.bytesWritten });
            }
            return json({ downloaded: results });
          }

          case "delete": {
            await ensureInitialized();
            const urls = params.fileUrls as string[] | undefined;
            if (!urls?.length) return text("No fileUrls provided.");
            validateFileUrls(urls, cfg.cameraHost);
            const result = await c.execute("camera.delete", { fileUrls: urls });
            return json(result);
          }

          default:
            return text(`Unknown action: ${action}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ECONNREFUSED") || msg.includes("ETIMEDOUT")) {
          return text(`Cannot reach camera at ${cfg.cameraHost}. Check WiFi connection.`);
        }
        if (msg.includes("unactivated")) {
          return text("Camera not activated. Use the Insta360 app to activate first.");
        }
        return text(`Error: ${msg}`);
      }
    },
  } as unknown as AnyAgentTool);

  // --- Command ---
  api.registerCommand({
    name: "cam",
    description:
      "Quick Insta360 control: /cam photo | record [timelapse] | stop | status | files [count]",
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";
      const tokens = args.split(/\s+/).filter(Boolean);
      const action = tokens[0]?.toLowerCase() ?? "";
      const c = getClient();

      try {
        switch (action) {
          case "photo": {
            await ensureInitialized();
            await c.execute("camera.setOptions", { options: { captureMode: "image" } });
            const result = await c.executeAndWait("camera.takePicture");
            return { text: JSON.stringify(result, null, 2) };
          }
          case "record": {
            await ensureInitialized();
            const videoType = tokens[1] ?? "normal";
            await c.execute("camera.setOptions", {
              options: { captureMode: "video", _videoType: videoType },
            });
            const result = await c.execute("camera.startCapture");
            return {
              text: `Recording started (${videoType}).\n${JSON.stringify(result, null, 2)}`,
            };
          }
          case "stop": {
            const result = await c.execute("camera.stopCapture");
            monitor?.stop();
            return { text: `Recording stopped.\n${JSON.stringify(result, null, 2)}` };
          }
          case "status": {
            const state = await c.getState();
            const s = (state.state ?? state) as Record<string, unknown>;
            const batt =
              typeof s.batteryLevel === "number" ? Math.round(s.batteryLevel * 100) : "?";
            const storage =
              typeof s._storageRemainInMB === "number" ? Math.round(s._storageRemainInMB) : "?";
            const card = (s._cardState as string) ?? "unknown";
            return { text: `Battery: ${batt}% | Storage: ${storage}MB | SD: ${card}` };
          }
          case "files": {
            const count = Number.parseInt(tokens[1] ?? "10", 10) || 10;
            const result = await c.execute("camera.listFiles", {
              fileType: "all",
              entryCount: count,
              maxThumbSize: 0,
            });
            return { text: JSON.stringify(result, null, 2) };
          }
          default:
            return {
              text: "Usage: /cam photo | record [timelapse] | stop | status | files [count]",
            };
        }
      } catch (err) {
        return { text: `Error: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  // --- Service ---
  api.registerService({
    id: "insta360-monitor",
    start: async () => {
      api.logger.info("insta360: plugin loaded");
    },
    stop: async () => {
      monitor?.stop();
      initialized = false;
      client = null;
    },
  } as OpenClawPluginService);
}
