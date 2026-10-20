import fs from "node:fs";
import path from "node:path";
import { hashVitestWorkerArtifact } from "./vitest-worker-artifacts.mts";

/** A verified private clone supplies unchanged bytes; only this compiler writes its replacement. */
export function createVitestWorkerOutput(directory: string, previous: Record<string, string> = {}) {
  const outputs: Record<string, string> = {};
  const outDir = path.join(directory, "dist");
  let writtenFiles = 0;
  return {
    outputs,
    get writtenFiles() {
      return writtenFiles;
    },
    write(name: string, bytes: string | Buffer) {
      const hash = hashVitestWorkerArtifact(bytes);
      if ((outputs[name] ?? previous[name]) !== hash) {
        const filename = path.join(outDir, name);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, bytes);
        writtenFiles++;
      }
      outputs[name] = hash;
    },
    finish() {
      for (const name of Object.keys(previous)) {
        if (!Object.hasOwn(outputs, name)) {
          const filename = path.join(outDir, name);
          fs.rmSync(filename, { force: true });
          let parent = path.dirname(filename);
          while (parent.startsWith(`${outDir}${path.sep}`)) {
            try {
              fs.rmdirSync(parent);
            } catch (error) {
              if (["ENOTEMPTY", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) {
                break;
              }
              throw error;
            }
            parent = path.dirname(parent);
          }
        }
      }
    },
  };
}
