import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FFMPEG_TIMEOUT_MS = 30_000;
const MIN_PCM_BYTES = 4;

/**
 * Convert an audio buffer (any format ffmpeg supports) to raw 16 kHz mono
 * float32 little-endian PCM — the format the embedded Parakeet runtime expects.
 */
export async function convertToPcmF32(inputBuffer: Buffer, inputFileName: string): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "et-audio-"));
  const inputPath = path.join(tmpDir, inputFileName);
  const outputPath = path.join(tmpDir, "output.pcm");

  try {
    await fs.writeFile(inputPath, inputBuffer);

    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i",
        inputPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        outputPath,
      ],
      { timeout: FFMPEG_TIMEOUT_MS },
    );

    const pcm = await fs.readFile(outputPath);
    if (pcm.byteLength < MIN_PCM_BYTES) {
      throw new Error(
        `ffmpeg produced empty PCM output for "${inputFileName}". ` +
          "The source may be malformed or unsupported; re-encode to WAV/PCM and retry.",
      );
    }
    return pcm;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
