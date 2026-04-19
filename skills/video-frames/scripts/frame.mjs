#!/usr/bin/env node
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";

function usage() {
  console.error(`Usage:
  frame.mjs <video-file> [--time HH:MM:SS] [--index N] --out /path/to/frame.jpg

Examples:
  frame.mjs video.mp4 --out /tmp/frame.jpg
  frame.mjs video.mp4 --time 00:00:10 --out /tmp/frame-10s.jpg
  frame.mjs video.mp4 --index 0 --out /tmp/frame0.png`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
  usage();
}

const inVal = args.shift();

const { values } = parseArgs({
  args,
  options: {
    time: { type: "string" },
    index: { type: "string" },
    out: { type: "string" },
  },
  strict: false,
});

if (!inVal || !fs.existsSync(inVal)) {
  console.error(`File not found: ${inVal}`);
  process.exit(1);
}

if (!values.out) {
  console.error("Missing --out");
  usage();
}

const outDir = path.dirname(values.out);
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

let ffmpegArgs = ["-hide_banner", "-loglevel", "error", "-y"];

if (values.index !== undefined) {
  ffmpegArgs.push("-i", inVal, "-vf", `select=eq(n\\,${values.index})`, "-vframes", "1", values.out);
} else if (values.time !== undefined) {
  ffmpegArgs.push("-ss", values.time, "-i", inVal, "-frames:v", "1", values.out);
} else {
  ffmpegArgs.push("-i", inVal, "-vf", "select=eq(n\\,0)", "-vframes", "1", values.out);
}

const ffmpegBin = ffmpegStatic ?? process.env.FFMPEG_PATH ?? "ffmpeg";

try {
  execFileSync(ffmpegBin, ffmpegArgs, { stdio: "inherit" });
  console.log(values.out);
} catch (error) {
  console.error("FFmpeg extraction failed:", error.message ?? "unknown error");
  process.exit(error.status ?? 1);
}
