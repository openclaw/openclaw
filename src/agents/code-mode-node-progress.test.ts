import { expect, it } from "vitest";
import { captureCodeModeOutput } from "./code-mode-json.js";
import { CodeModeNodeProgress } from "./code-mode-node-progress.js";

it.each([1, 31, 32, 33, 128, 1024])(
  "retains the canonical output prefix within %d bytes after interruption",
  (limit) => {
    const progress = new CodeModeNodeProgress(limit);
    const entries = [
      { type: "text", text: "before 🦞" },
      { type: "json", value: { text: "界".repeat(100) } },
    ];
    for (const entry of entries) {
      progress.append(JSON.stringify(entry));
    }
    expect(progress.output()).toEqual(captureCodeModeOutput(entries, limit));
    progress.resetOutput();
    progress.append(JSON.stringify(entries[0]));
    expect(progress.output()).toEqual(captureCodeModeOutput([entries[0]], limit));
  },
);
