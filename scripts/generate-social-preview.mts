import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import {
  renderSocialPreviewSvg,
  socialPreviewFontFiles,
} from "../ui/config/control-ui-social-preview.ts";

// Authoring tool, not a build dependency. Releases copy the authored MP4 from ui/public.
// Bump the asset name and its share-route mapping when replacing published artwork.
const output = fileURLToPath(new URL("../ui/public/social-preview-v1.mp4", import.meta.url));
const fontFiles = socialPreviewFontFiles.map((file) => fileURLToPath(file));
const frames: Buffer[] = [];
for (let frame = 0; frame < 120; frame += 1) {
  frames.push(
    new Resvg(renderSocialPreviewSvg(frame / 24), {
      font: { loadSystemFonts: false, fontFiles },
    })
      .render()
      .asPng(),
  );
}
const result = spawnSync(
  "ffmpeg",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "image2pipe",
    "-framerate",
    "24",
    "-i",
    "pipe:0",
    "-an",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-preset",
    "slow",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-map_metadata",
    "-1",
    output,
  ],
  { input: Buffer.concat(frames), maxBuffer: 1024 * 1024 },
);
if (result.error || result.status !== 0) {
  throw new Error(
    "Social preview encoding requires system ffmpeg with libx264. " +
      (result.error?.message ?? result.stderr.toString()),
  );
}
console.log(output);
