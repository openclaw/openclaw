import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const MAX_PENDING_LINE_CHARS = 1_000_000;

export function relayChildStream(
  stream: Readable,
  label: string,
  recordLine: (line: string) => void,
) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const writeLine = (rawLine: string) => {
    // Test names can contain NUL; keep the job log searchable as text.
    const line = rawLine.replaceAll("\0", "\\0");
    recordLine(line);
    // Actions only parses workflow commands at the start of a line.
    const workflowCommand = /^::(?:error|warning|notice|group|endgroup)(?: .*?)?::/u.test(line);
    const output = workflowCommand ? line : `[shard:${label}] ${line}`;
    if (!process.stdout.write(`${output}\n`)) {
      stream.pause();
      process.stdout.once("drain", () => stream.resume());
    }
  };
  stream.on("data", (chunk: Buffer | string) => {
    pending += decoder.write(chunk);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      writeLine(line);
    }
    if (pending.length > MAX_PENDING_LINE_CHARS) {
      writeLine(pending);
      pending = "";
    }
  });
  return () => {
    pending += decoder.end();
    if (pending !== "") {
      writeLine(pending);
      pending = "";
    }
  };
}
