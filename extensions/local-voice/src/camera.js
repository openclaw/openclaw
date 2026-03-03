import { execSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOpenAICodexAuth } from "./auth.js";
const DEFAULT_CAMERA_CONFIG = {
    width: 640,
    height: 480,
    format: "jpg",
};
export function captureImage(config) {
    const cfg = { ...DEFAULT_CAMERA_CONFIG, ...config };
    const tmpFile = join(tmpdir(), `camera-${Date.now()}.${cfg.format}`);
    try {
        const platform = process.platform;
        let command;
        switch (platform) {
            case "win32":
                command = getWindowsCaptureCommand(tmpFile, cfg);
                break;
            case "darwin":
                command = getMacCaptureCommand(tmpFile, cfg);
                break;
            case "linux":
                command = getLinuxCaptureCommand(tmpFile, cfg);
                break;
            default:
                return { success: false, error: `Unsupported platform: ${platform}` };
        }
        execSync(command, { timeout: 5000, stdio: "pipe" });
        const data = readFileSync(tmpFile);
        unlinkSync(tmpFile);
        return { success: true, data };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Camera capture failed: ${message}` };
    }
}
function getWindowsCaptureCommand(outputPath, _config) {
    return `ffmpeg -f dshow -i video="Integrated Camera" -frames:v 1 -y "${outputPath}" 2>nul`;
}
function getMacCaptureCommand(outputPath, _config) {
    return `imagesnap -q "${outputPath}"`;
}
function getLinuxCaptureCommand(outputPath, config) {
    return `fswebcam -r ${config.width}x${config.height} "${outputPath}"`;
}
export async function analyzeImage(imageData) {
    const authResult = await loadOpenAICodexAuth();
    if (!authResult.success || !authResult.accessToken) {
        return { success: false, error: authResult.error ?? "Authentication failed" };
    }
    const base64 = imageData.toString("base64");
    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${authResult.accessToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "gpt-4o",
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: "Describe what you see in this camera image. Be concise and natural.",
                            },
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:image/jpeg;base64,${base64}`,
                                },
                            },
                        ],
                    },
                ],
                max_tokens: 300,
            }),
        });
        if (!response.ok) {
            return { success: false, error: `Vision API error: ${response.status}` };
        }
        const data = (await response.json());
        const description = data.choices?.[0]?.message?.content;
        if (!description) {
            return { success: false, error: "No description returned" };
        }
        return { success: true, description };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Vision analysis failed: ${message}` };
    }
}
export async function captureAndAnalyze(config) {
    const captureResult = captureImage(config);
    if (!captureResult.success || !captureResult.data) {
        return { success: false, error: captureResult.error ?? "Capture failed" };
    }
    return analyzeImage(captureResult.data);
}
export function saveDebugImage(imageData, filename) {
    const outputPath = join(tmpdir(), filename ?? `camera-debug-${Date.now()}.jpg`);
    writeFileSync(outputPath, imageData);
    return outputPath;
}
