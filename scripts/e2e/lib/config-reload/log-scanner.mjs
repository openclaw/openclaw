import {
  createIncrementalLineReader,
  resolvePositiveInteger,
} from "../incremental-line-reader.mjs";

const DEFAULT_TAIL_LINE_LIMIT = 160;
const RELOAD_NEEDLE = "config change detected; evaluating reload";
const RESTART_NEEDLE = "config change requires gateway restart";

export function createConfigReloadLogScanner(logPath, options = {}) {
  const tailLineLimit = resolvePositiveInteger(options.tailLineLimit, DEFAULT_TAIL_LINE_LIMIT);
  const reader = createIncrementalLineReader(logPath, { maxReadBytes: options.maxReadBytes });
  let tailLines = [];
  const reloadLines = [];
  const restartLines = [];

  return {
    scan() {
      const { lines, reset } = reader.readLines();
      if (reset) {
        tailLines = [];
        reloadLines.length = 0;
        restartLines.length = 0;
      }
      for (const line of lines) {
        const trimmed = line.replace(/\r$/u, "");
        tailLines.push(trimmed);
        if (trimmed.includes(RELOAD_NEEDLE)) {
          reloadLines.push(trimmed);
        }
        if (trimmed.includes(RESTART_NEEDLE)) {
          restartLines.push(trimmed);
        }
      }
      if (tailLines.length > tailLineLimit) {
        tailLines = tailLines.slice(-tailLineLimit);
      }
      return { reloadLines, restartLines, tailLines };
    },
  };
}
