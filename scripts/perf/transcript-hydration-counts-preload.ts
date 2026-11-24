// Synthetic benchmark observation only; never loaded by the normal Gateway.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (!url.endsWith("/session-transcript-worker-readers.ts")) {
        return loaded;
      }
      // Read TypeScript directly: another loader may already have transformed its text.
      let source = readFileSync(new URL(url), "utf8");
      const replacements = [
        [
          "readTranscript: async (input, signal) => {",
          `readTranscript: async (input, signal) => {
            const countStack = new Error().stack;
            const countStarted = Date.now();
            let decodedBytes = 0;`,
        ],
        [
          "parts.push(frame.data);",
          "decodedBytes += frame.data.byteLength; parts.push(frame.data);",
        ],
        [
          '      return await runRequest(\n        () => ({ kind: "transcript-hydration", ...input }),',
          '      const countedResult = await runRequest(\n        () => ({ kind: "transcript-hydration", ...input }),',
        ],
        [
          "        input.limits ? undefined : receiveChunk,\n      );",
          `        input.limits ? undefined : receiveChunk,
          );
          process.stderr.write('HYDRATION_COUNT ' + JSON.stringify({
            started: countStarted, ended: Date.now(), session: input.target.sessionId,
            limits: input.limits, afterSeq: input.afterSeq, includeEventJson: input.includeEventJson,
            decodedBytes, decodedEvents: events.length, kind: countedResult.kind, stack: countStack
          }) + '\\n');
          return countedResult;`,
        ],
      ];
      for (const [before, after] of replacements) {
        if (!before || after === undefined || source.split(before).length !== 2) {
          throw new Error(`Transcript hydration observation source changed: ${before}`);
        }
        source = source.replace(before, after);
      }
      process.stderr.write("HYDRATION_COUNT_INSTALLED\n");
      return { ...loaded, format: "module-typescript", source };
    },
  });
}
