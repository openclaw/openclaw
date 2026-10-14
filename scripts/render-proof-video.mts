#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { chromium } from "playwright";
import { resolveSystemBin } from "../src/infra/resolve-system-bin.ts";
import { resolvePlaywrightChromiumExecutablePath } from "../ui/src/test-helpers/control-ui-e2e.ts";
import { rasterizeCaptions } from "../ui/src/test-helpers/proof-video.ts";
import { planProofVideoRender, validateProofVideoCues } from "./lib/proof-video-render.ts";

const run = promisify(execFile);
const hint = "Install a full system build: brew install ffmpeg or apt install ffmpeg";
async function main() {
  const { values } = parseArgs({
    options: {
      cues: { type: "string" },
      input: { type: "string" },
      out: { type: "string" },
      rasterize: { type: "boolean", default: false },
    },
  });
  if (!values.cues) {
    throw new Error(
      "Usage: --cues <dir>/cues.json [--input <video>] [--out <dir>/proof.mp4] [--rasterize]",
    );
  }
  const ffmpeg = resolveSystemBin("ffmpeg", { trust: "standard" });
  const ffprobe = resolveSystemBin("ffprobe", { trust: "standard" });
  if (!ffmpeg || !ffprobe) {
    throw new Error(hint);
  }
  const { stdout: filters } = await run(ffmpeg, ["-hide_banner", "-filters"]);
  for (const filter of ["crop", "scale", "overlay", "setpts", "trim", "concat", "zoompan", "fps"]) {
    if (!new RegExp(`\\s${filter}\\s`).test(filters)) {
      throw new Error(`ffmpeg lacks ${filter}. ${hint}`);
    }
  }
  const cues: unknown = JSON.parse(await readFile(values.cues, "utf8"));
  validateProofVideoCues(cues);
  const dir = path.dirname(path.resolve(values.cues));
  const input = path.resolve(values.input ?? path.join(dir, cues.video));
  const output = path.resolve(values.out ?? path.join(dir, "proof.mp4"));
  if (path.extname(output).toLowerCase() !== ".mp4") {
    throw new Error("Output must be an .mp4 file");
  }
  const { stdout } = await run(ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,r_frame_rate,avg_frame_rate,duration:format=duration",
    "-of",
    "json",
    input,
  ]);
  const probe: {
    streams: {
      width: number;
      height: number;
      r_frame_rate: string;
      avg_frame_rate: string;
      duration?: string;
    }[];
    format: { duration: string };
  } = JSON.parse(stdout);
  const stream = probe.streams[0];
  if (
    !stream ||
    stream.width !== cues.viewport.width * cues.scale ||
    stream.height !== cues.viewport.height * cues.scale
  ) {
    throw new Error(
      "Input dimensions must equal viewport × scale; inspect raw content for padding before rendering",
    );
  }
  const rate = (value: string) => {
    const [n, d] = value.split("/");
    return Number(n) / Number(d);
  };
  const fps = rate(stream.r_frame_rate);
  const averageFps = rate(stream.avg_frame_rate);
  if (
    !Number.isFinite(fps) ||
    fps <= 0 ||
    !Number.isFinite(averageFps) ||
    Math.abs(averageFps - fps) > 0.001
  ) {
    throw new Error("Proof rendering requires constant-frame-rate video");
  }
  const plan = planProofVideoRender(cues, {
    durationSeconds: Number(stream.duration ?? probe.format.duration),
    fps,
  });
  const missing = [];
  for (const cue of cues.cues) {
    if (cue.kind !== "caption") {
      continue;
    }
    try {
      await access(path.join(dir, cue.image));
    } catch {
      missing.push(cue);
    }
  }
  if (missing.length && !values.rasterize) {
    throw new Error("Caption PNGs are missing; rerun with --rasterize");
  }
  if (missing.length) {
    const browser = await chromium.launch({
      executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    });
    try {
      await rasterizeCaptions(browser, { ...cues, cues: missing }, dir);
    } finally {
      await browser.close();
    }
  }
  await run(
    ffmpeg,
    [
      "-nostdin",
      "-n",
      "-loglevel",
      "error",
      "-i",
      input,
      ...plan.inputs.flatMap((image) => [
        "-loop",
        "1",
        "-framerate",
        String(fps),
        "-i",
        path.join(dir, image),
      ]),
      "-filter_complex",
      plan.filterComplex,
      "-map",
      plan.outputMap,
      "-an",
      "-t",
      String(plan.durationSeconds),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "23",
      "-movflags",
      "+faststart",
      output,
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  console.log(`${output}\nDuration: ${plan.durationSeconds.toFixed(3)} seconds`);
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
