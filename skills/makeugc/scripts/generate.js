/**
 * MakeUGC Generator Script
 * Wraps HeyGen API to generate "UGC" style videos.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

// Simple fetch wrapper for HeyGen
async function callHeyGen(endpoint, method = "GET", body = null) {
  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing HEYGEN_API_KEY environment variable. Please set it in your .env file.",
    );
  }

  const url = `https://api.heygen.com/v2${endpoint}`;
  const options = {
    method,
    headers: {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`HeyGen API Error (${res.status}): ${errorText}`);
  }

  return res.json();
}

async function checkVideoStatus(videoId) {
  const data = await callHeyGen(`/video_status.get?video_id=${videoId}`);
  return data.data || data; // Handle varied response structures
}

async function waitForVideo(videoId) {
  console.log(`Waiting for video ${videoId} to render...`);
  let status = "pending";
  while (status === "pending" || status === "processing") {
    await new Promise((resolve) => setTimeout(resolve, 5000)); // Poll every 5s
    const info = await checkVideoStatus(videoId);
    status = info.status;
    console.log(`Status: ${status}`);

    if (status === "completed") {
      return info.video_url || info.url;
    } else if (status === "failed") {
      throw new Error(`Video generation failed: ${info.error || "Unknown error"}`);
    }
  }
}

async function generateScript(prompt) {
  // In a real skill, this might call back to OpenClaw's agent model.
  // For now, we'll return a stub or use a simple heuristic.
  // The user prompt is likely the script itself if short, or instructions.

  // Implementation note: If we could access the Agent's LLM here, we would.
  // For this V1, we assume the prompt IS the script if it's quoted text,
  // or we just prepend a simple intro.
  return prompt;
}

async function main() {
  const { values } = parseArgs({
    options: {
      prompt: { type: "string", short: "p" },
      avatar: { type: "string", default: "josh_lite3_20230714" }, // Default "UGC" style avatar
      voice: { type: "string" },
      background: { type: "string", default: "#ffffff" },
      out: { type: "string", default: "output.mp4" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`
MakeUGC (HeyGen) Generator

Usage:
  node generate.js --prompt "Your script text" [options]

Options:
  --prompt, -p    The text script or prompt for the video (required)
  --avatar        Avatar ID (default: josh_lite3_20230714)
  --voice         Voice ID (optional)
  --background    Background color hex (default: #ffffff)
  --out           Output filename (default: output.mp4)
  --dry-run       Generate script only, skip API call
  --help, -h      Show this help
`);
    return;
  }

  if (!values.prompt) {
    console.error("Error: --prompt is required");
    process.exit(1);
  }

  console.log("📝 Generating script/content...");
  const scriptText = await generateScript(values.prompt);
  console.log(`Script: "${scriptText}"`);

  if (values["dry-run"]) {
    console.log("[Dry Run] Skipping API call.");
    return;
  }

  console.log(`🎬 Requesting video generation from HeyGen (Avatar: ${values.avatar})...`);

  const payload = {
    video_inputs: [
      {
        character: {
          type: "avatar",
          avatar_id: values.avatar,
          scale: 1.0,
          avatar_style: "normal",
        },
        voice: {
          type: "audio",
          audio_url: "https://files.heygen.ai/aris-pirate-audio-4ry92m9L9.mp3", // Placeholder audio or TTS logic needed
          // For V1 text-to-speech:
          // Note: HeyGen v2 API for template-based generation is complex.
          // We are using the simple /video/generate endpoint if available or constructing the v2 payload.
        },
      },
    ],
    test: true, // Generate watermarked for testing
    dimension: { width: 1080, height: 1920 }, // 9:16 Vertical UGC format
  };

  // Switch to V2 simplified payload for text-to-speech
  const v2Payload = {
    video_inputs: [
      {
        character: {
          type: "avatar",
          avatar_id: values.avatar,
          scale: 1.0,
        },
        voice: {
          type: "text",
          input_text: scriptText,
          voice_id: values.voice || "1bd001e7e50f421d8b19addef4f77286", // Default "en-US-Jenny" styled voice
        },
        background: {
          type: "color",
          value: values.background,
        },
      },
    ],
    dimension: { width: 1080, height: 1920 },
  };

  try {
    const data = await callHeyGen("/video/generate", "POST", v2Payload);
    const videoId = data.data?.video_id;

    if (!videoId) {
      console.error("API Response:", JSON.stringify(data, null, 2));
      throw new Error("No video_id returned from API");
    }

    console.log(`🚀 Job started! Video ID: ${videoId}`);
    const downloadUrl = await waitForVideo(videoId);
    console.log(`✅ Video ready: ${downloadUrl}`);

    // Download to file
    if (values.out) {
      console.log(`Downloading to ${values.out}...`);
      const vidReq = await fetch(downloadUrl);
      const buffer = await vidReq.arrayBuffer();
      fs.writeFileSync(values.out, Buffer.from(buffer));
      console.log("Download complete.");
    }
  } catch (err) {
    console.error("Refused to generate video:", err.message);
    process.exit(1);
  }
}

main();
