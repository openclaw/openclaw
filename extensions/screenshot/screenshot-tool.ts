import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import type { AnyAgentTool, OpenClawPluginToolContext } from "./api.js";

const CAPTURE_TIMEOUT_MS = 30_000;
const SCREENSHOT_DIR = "screenshots";
const OUTPUT_ENV = "OPENCLAW_SCREENSHOT_OUT";

// The output path travels in the environment, not in the script text, so it is
// never parsed as PowerShell. SetProcessDPIAware makes the capture cover the
// full physical resolution on scaled displays.
const WINDOWS_CAPTURE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class OpenClawDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][OpenClawDpi]::SetProcessDPIAware()
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
$bitmap.Save($env:${OUTPUT_ENV}, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`;

const ScreenshotToolSchema = Type.Object(
  {
    send: Type.Optional(
      Type.Boolean({
        description:
          "Send the screenshot to the current conversation (default true). Set false to only save it in the workspace.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function isScreenshotPlatformSupported(platform: NodeJS.Platform = process.platform) {
  return platform === "win32";
}

const WINDOWS_CAPTURE_COMMAND = [
  "powershell.exe",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
  Buffer.from(WINDOWS_CAPTURE_SCRIPT, "utf16le").toString("base64"),
];

function buildOutputPath(workspaceDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(workspaceDir, SCREENSHOT_DIR, `screenshot-${stamp}.png`);
}

async function captureScreen(
  outputPath: string,
  assertCurrent: () => void,
  signal?: AbortSignal,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  // The capture is the privileged effect and cannot be undone, so authority is
  // revalidated after the awaited preparation, immediately before launching it.
  signal?.throwIfAborted();
  assertCurrent();
  const result = await runCommandWithTimeout(WINDOWS_CAPTURE_COMMAND, {
    timeoutMs: CAPTURE_TIMEOUT_MS,
    env: { ...process.env, [OUTPUT_ENV]: outputPath },
  });
  if (result.code !== 0) {
    throw new Error(
      `Screen capture failed (exit ${result.code ?? "unknown"}): ${result.stderr.trim() || "no error output"}`,
    );
  }
  const stat = await fs.stat(outputPath).catch(() => undefined);
  if (!stat || stat.size === 0) {
    throw new Error("Screen capture produced no image. Is a desktop session available?");
  }
}

export function createScreenshotTool(context: OpenClawPluginToolContext<2>): AnyAgentTool {
  return {
    name: "screenshot",
    label: "Screenshot",
    description:
      "Capture the Gateway host's screen, save it as a PNG in the workspace, and send it to the current conversation. Owner only. The image is not returned to the model.",
    parameters: ScreenshotToolSchema,
    async execute(_toolCallId: string, rawParams: Record<string, unknown>, signal?: AbortSignal) {
      const workspaceDir = context.workspaceDir;
      if (!workspaceDir) {
        throw new Error("screenshot needs an agent workspace to save the image.");
      }
      signal?.throwIfAborted();
      context.assertInvocationCurrent();
      const outputPath = buildOutputPath(workspaceDir);
      await captureScreen(outputPath, context.assertInvocationCurrent, signal);

      let delivered = false;
      let deliveryNote = "Not sent (send=false).";
      if (rawParams.send !== false) {
        if (context.delivery) {
          // Revalidate after the awaited capture, right before the outbound effect.
          signal?.throwIfAborted();
          context.assertInvocationCurrent();
          await context.delivery.send({ mediaUrl: outputPath });
          delivered = true;
          deliveryNote = "Sent to the current conversation.";
        } else {
          deliveryNote = "Not sent: this channel has no direct delivery. Send the saved file.";
        }
      }
      return jsonResult({ path: outputPath, delivered, note: deliveryNote });
    },
  };
}
