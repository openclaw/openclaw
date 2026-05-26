import { detectImageReferences } from "../src/agents/pi-embedded-runner/run/images.ts";

const refs1 = detectImageReferences("Called Read with /Users/trevor/.openclaw/workspace/.openclaw-cli-images/a1b2c3d4.png");
const refs2 = detectImageReferences("System reminder: file_path /tmp/.openclaw-cli-images/e5f6g7h8.jpg");
const refs3 = detectImageReferences("See ./.openclaw-cli-images/image.webp for details");
console.log({ refs1Count: refs1.length, refs2Count: refs2.length, refs3Count: refs3.length });

// Verify normal images still work
const normal = detectImageReferences("Look at /path/to/screenshot.png");
console.log({ normalCount: normal.length, normalPath: normal[0]?.resolved });
