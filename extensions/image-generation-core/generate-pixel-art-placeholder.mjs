import { writePixelArtPlaceholder } from "./src/pixel-art-placeholder.ts";

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
if (!args.prompt) {
  console.error("Missing required --prompt argument");
  process.exit(1);
}

const result = await writePixelArtPlaceholder({
  prompt: args.prompt,
  seed: args.seed,
  outputPath: args.out ?? "tmp/pixel-art-placeholder.png",
  width: args.width ? Number(args.width) : undefined,
  height: args.height ? Number(args.height) : undefined,
  pixelScale: args.scale ? Number(args.scale) : undefined,
});

console.log(
  JSON.stringify(
    {
      outputPath: result.outputPath,
      fileName: result.asset.fileName,
      mimeType: result.asset.mimeType,
      metadata: result.asset.metadata,
    },
    null,
    2,
  ),
);
