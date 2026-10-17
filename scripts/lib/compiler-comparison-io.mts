import assert from "node:assert/strict";
import fs from "node:fs";

/** Bound both streams before retaining bytes in memory or writing host artifacts. */
export function captureCompilerComparisonOutput(files?: { stdout: number; stderr: number }) {
  const chunks: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
  let bytes = 0;
  return {
    accept(chunk: Buffer, stream: "stdout" | "stderr") {
      bytes += chunk.length;
      assert(bytes <= 64 * 1024 * 1024, "Compiler output exceeded 64 MiB");
      if (files) {
        fs.writeFileSync(files[stream], chunk);
      } else {
        chunks[stream].push(chunk);
      }
    },
    finish() {
      return {
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
      };
    },
  };
}

/** Read GNU time output without trusting the compiler-writable pathname. */
export function readCompilerComparisonMetrics(file: string) {
  // NOFOLLOW rejects symlinks; NONBLOCK lets the descriptor check reject FIFOs
  // without waiting for a writer after the compiler's timeout has ended.
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  let text: string;
  try {
    const stat = fs.fstatSync(fd);
    assert(stat.isFile(), "Metric input must be a regular file");
    assert(stat.size <= 4096, "Metric input exceeds 4096 bytes");
    text = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  const values = text.trim().split("\n").at(-1)?.trim().split(/\s+/u).map(Number);
  assert(
    values?.length === 5 && values.every((value) => Number.isFinite(value) && value >= 0),
    "Invalid compiler metrics",
  );
  return values as [number, number, number, number, number];
}
