/**
 * Word-level timestamp extraction via whisper.cpp (free, local, Metal/CoreML).
 *
 * Replaces the old WhisperX Python pipeline which was failing due to dep hell.
 * whisper.cpp is pure C++ with Apple-Silicon-native acceleration; install via
 * `brew install whisper-cpp` and download a model (default base.en, ~147 MB).
 *
 * If whisper-cli or the model file is missing, returns an empty array so
 * downstream Remotion captions degrade gracefully (no captions shown) instead
 * of crashing the pipeline.
 */
import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, basename } from "node:path";
import { promisify } from "node:util";
import type { WordTimestamp } from "../../remotion/types.js";

const execAsync = promisify(exec);

const DEFAULT_MODEL_PATH = join(homedir(), ".openclaw", "models", "whisper", "ggml-base.en.bin");

export interface WhisperCppOpts {
  /** Path to the GGML model file. Defaults to ~/.openclaw/models/whisper/ggml-base.en.bin */
  modelPath?: string;
  /** whisper-cli binary name. Defaults to "whisper-cli" (from `brew install whisper-cpp`). */
  bin?: string;
}

/** Pure: parse whisper.cpp's --output-json-full output into the WordTimestamp shape. */
export function parseWhisperJson(json: string): WordTimestamp[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }

  const obj = (data ?? {}) as {
    transcription?: Array<{
      tokens?: Array<{
        text?: string;
        offsets?: { from?: number; to?: number };
      }>;
      offsets?: { from?: number; to?: number };
      text?: string;
    }>;
  };

  const words: WordTimestamp[] = [];
  for (const seg of obj.transcription ?? []) {
    // Token-level (preferred when -ml 1 is set)
    const tokens = seg.tokens ?? [];
    if (tokens.length > 0) {
      for (const tok of tokens) {
        const word = (tok.text ?? "").trim();
        if (!word) continue;
        // Skip whisper internal tokens like [_BEG_], [_TT_], etc.
        if (word.startsWith("[_") || word.startsWith("<")) continue;
        const fromMs = tok.offsets?.from ?? 0;
        const toMs = tok.offsets?.to ?? fromMs;
        words.push({
          word,
          start: fromMs / 1000,
          end: toMs / 1000,
        });
      }
      continue;
    }
    // Fallback: segment-level (no -ml 1 emitted token rows)
    const segText = (seg.text ?? "").trim();
    if (segText && seg.offsets) {
      const fromMs = seg.offsets.from ?? 0;
      const toMs = seg.offsets.to ?? fromMs;
      // Spread the segment evenly across its words
      const segWords = segText.split(/\s+/).filter(Boolean);
      const dur = (toMs - fromMs) / 1000;
      const per = segWords.length > 0 ? dur / segWords.length : 0;
      segWords.forEach((w, i) => {
        words.push({
          word: w,
          start: fromMs / 1000 + i * per,
          end: fromMs / 1000 + (i + 1) * per,
        });
      });
    }
  }

  return words;
}

/**
 * Extract word-level timestamps from audio using whisper.cpp.
 *
 * Returns an empty array on any failure (missing binary, missing model, or
 * exec error) so the pipeline never blocks on subtitles. Failures are logged
 * to console.warn so they're visible during a run.
 */
export async function getWordTimestamps(
  audioPath: string,
  outputDir: string,
  opts: WhisperCppOpts = {},
): Promise<WordTimestamp[]> {
  if (!existsSync(audioPath)) {
    console.warn("  ⚠ Audio file not found for timestamp extraction");
    return [];
  }

  const rawModelPath = opts.modelPath ?? DEFAULT_MODEL_PATH;
  // Expand leading `~/` so config.yaml can use the home shortcut
  const modelPath = rawModelPath.startsWith("~/")
    ? join(homedir(), rawModelPath.slice(2))
    : rawModelPath;
  const bin = opts.bin ?? "whisper-cli";

  if (!existsSync(modelPath)) {
    console.warn(
      `  ⚠ Whisper model not found at ${modelPath}. Install: brew install whisper-cpp && mkdir -p ${dirname(modelPath)} && curl -L -o ${modelPath} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${basename(modelPath)}`,
    );
    return [];
  }

  // whisper.cpp writes <audioPath>.json next to the input. We use --output-json-full
  // for token-level offsets and -ml 1 to force word-level segments.
  try {
    console.log("  📝 Extracting word-level timestamps with whisper.cpp...");
    await execAsync(
      `${bin} -m "${modelPath}" -f "${audioPath}" --output-json-full -ml 1 -of "${join(outputDir, "whisper-out")}"`,
      { timeout: 180_000 },
    );

    const jsonPath = join(outputDir, "whisper-out.json");
    if (!existsSync(jsonPath)) {
      console.warn("  ⚠ whisper.cpp produced no JSON output");
      return [];
    }

    const raw = await readFile(jsonPath, "utf-8");
    const words = parseWhisperJson(raw);
    console.log(`  ✓ ${words.length} word timestamps extracted`);
    return words;
  } catch (err) {
    console.warn(`  ⚠ whisper.cpp failed: ${(err as Error).message.slice(0, 150)}`);
    return [];
  }
}
