/**
 * Programmatic Remotion renderer.
 *
 * Usage:
 *   npx tsx src/remotion/render.ts --output /tmp/test.mp4
 *   npx tsx src/remotion/render.ts --props script.json --audio combined.wav --words words.json --output video.mp4
 */

import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { VideoProps, SlideData } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function renderVideo(
  props: VideoProps,
  outputPath: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  console.log("  📦 Bundling Remotion project...");
  const bundled = await bundle({
    entryPoint: resolve(__dirname, "./index.ts"),
    onProgress: (p) => {
      if (p === 100) console.log("  ✓ Bundle complete");
    },
  });

  const totalFrames = props.slides.reduce((sum, s) => sum + s.durationFrames, 0);

  console.log(
    `  🎬 Rendering ${totalFrames} frames (${(totalFrames / 30).toFixed(1)}s at 30fps)...`,
  );

  const composition = await selectComposition({
    serveUrl: bundled,
    id: "NewsVideo",
    inputProps: props,
  });

  // Override duration based on actual slide durations
  composition.durationInFrames = totalFrames;

  await renderMedia({
    composition,
    serveUrl: bundled,
    codec: "h264",
    outputLocation: outputPath,
    inputProps: props,
    onProgress: ({ progress }) => {
      const pct = Math.round(progress * 100);
      if (pct % 10 === 0) onProgress?.(pct);
    },
  });

  console.log(`  ✓ Video rendered: ${outputPath}`);
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2);
  const outputIdx = args.indexOf("--output");
  const propsIdx = args.indexOf("--props");
  const audioIdx = args.indexOf("--audio");
  const wordsIdx = args.indexOf("--words");

  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : join(tmpdir(), "test-remotion.mp4");

  let props: VideoProps;

  if (propsIdx >= 0) {
    // Load from script.json
    const scriptPath = args[propsIdx + 1];
    const script = JSON.parse(readFileSync(scriptPath, "utf-8"));
    const audioPath = audioIdx >= 0 ? args[audioIdx + 1] : "";
    const wordsPath = wordsIdx >= 0 ? args[wordsIdx + 1] : "";
    const words =
      wordsPath && existsSync(wordsPath) ? JSON.parse(readFileSync(wordsPath, "utf-8")) : [];

    props = {
      slides: script.slides.map((s: SlideData) => ({
        ...s,
        durationFrames: s.durationFrames ?? 150,
      })),
      audioPath,
      words,
    };
  } else {
    // Test with default props
    props = {
      slides: [
        {
          slideType: "intro",
          title: "Today in Tech",
          body: ["AI breakthroughs", "Open source tools", "Industry news"],
          speakerNotes: "",
          durationFrames: 120,
        },
        {
          slideType: "story",
          title: "AI Gets Smarter",
          body: ["New models released", "Open source grows", "Enterprise adoption"],
          speakerNotes: "",
          sourceUrl: "https://news.ycombinator.com",
          durationFrames: 150,
        },
        {
          slideType: "outro",
          title: "That's a Wrap!",
          body: ["Subscribe for more", "Share with friends"],
          speakerNotes: "",
          durationFrames: 90,
        },
      ],
      audioPath: "",
      words: [],
    };
  }

  console.log("🎬 Remotion Video Renderer\n");
  console.log(`  Slides: ${props.slides.length}`);
  console.log(`  Audio: ${props.audioPath || "none"}`);
  console.log(`  Words: ${props.words.length}`);
  console.log(`  Output: ${outputPath}\n`);

  await renderVideo(props, outputPath, (pct) => {
    process.stdout.write(`  Rendering: ${pct}%\r`);
  });

  console.log(`\n✅ Done! Open: ${outputPath}`);
}

main().catch((err) => {
  console.error("❌ Render failed:", err.message);
  process.exit(1);
});
