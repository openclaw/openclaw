import { appendFileSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { threadId } from "node:worker_threads";
const file = `${process.env.COMPACTION_SCALE_WORKER_TRACE}-${threadId}.jsonl`;
let loads = 0;
const emit = (event) =>
  appendFileSync(file, JSON.stringify({ threadId, at: Date.now(), ...event }) + "\n");
globalThis.compactionWorkloadTrace = (event) => emit({ ...event, loads });
emit({ kind: "start", argv: process.execArgv });
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    emit({ kind: "resolve", parent: context.parentURL, specifier, url: result.url });
    return result;
  },
  load(url, context, next) {
    const start = performance.now();
    const loaded = next(url, context);
    loads++;
    emit({ kind: "load", url, wallMs: performance.now() - start });
    if (url.endsWith("/session-transcript.worker.ts")) {
      let text = readFileSync(new URL(url), "utf8");
      for (const [name, path] of [
        ["readPreparedSessionCompaction", "session-compaction-prepared.worker"],
        ["readSessionTranscriptHydrationRequest", "session-transcript-hydration-read.worker"],
      ]) {
        const pattern = new RegExp(
          `const \\{ ${name} \\} =\\s*await import\\("\\./${path}\\.js"\\);`,
        );
        text = text.replace(
          pattern,
          `const scaleImportStart=performance.now(); globalThis.compactionWorkloadTrace({kind:'import-start',name:'${name}',operation:request.operation?.kind});\n$&\nglobalThis.compactionWorkloadTrace({kind:'import-end',name:'${name}',operation:request.operation?.kind,wallMs:performance.now()-scaleImportStart});`,
        );
      }
      return { ...loaded, format: "module-typescript", source: text };
    }
    return loaded;
  },
});
