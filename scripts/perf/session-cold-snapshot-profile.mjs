/** Opt-in stage profiling for session-cold-writer; transforms only the loaded prepare module. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { StatementSync } from "node:sqlite";

export function installSnapshotProfile() {
  const phases = {};
  let reading = false;
  let stage;
  let started;
  const add = (name, ms) => {
    const bucket = (phases[name] ??= { calls: 0, ms: 0 });
    bucket.calls++;
    bucket.ms += ms;
  };
  const profile = {
    reading(value) {
      reading = value;
    },
    begin(name) {
      stage = name;
      started = performance.now();
    },
    end() {
      add(stage, performance.now() - started);
      stage = undefined;
    },
    result() {
      return phases;
    },
  };
  globalThis.coldSnapshotProfile = profile;
  for (const method of ["get", "all", "iterate"]) {
    const original = StatementSync.prototype[method];
    StatementSync.prototype[method] = function (...args) {
      const timed = (run) => {
        if (!reading || stage) {
          return run();
        }
        const start = performance.now();
        try {
          return run();
        } finally {
          add("rowRead", performance.now() - start);
        }
      };
      const result = timed(() => original.apply(this, args));
      if (method === "iterate") {
        const next = result.next.bind(result);
        result.next = (...nextArgs) => timed(() => next(...nextArgs));
      }
      return result;
    };
  }
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.endsWith("/session-cold-storage-prepare.ts")) {
        return nextLoad(url, context);
      }
      const original = fs.readFileSync(new URL(url), "utf8");
      const boundary = original.indexOf("function prepareSessionColdArchiveInWorker(");
      assert(boundary >= 0, "Missing cold preparation owner");
      let source = original.slice(boundary);
      const replace = (before, after) => {
        assert(source.includes(before), `Missing snapshot profiling boundary: ${before}`);
        source = source.replace(before, after);
      };
      const begin = (name) => `globalThis.coldSnapshotProfile.begin("${name}");`;
      const end = "globalThis.coldSnapshotProfile.end();";
      replace("() => {", "() => { globalThis.coldSnapshotProfile.reading(true);");
      replace(
        "const line = `${JSON.stringify(record)}\\n`;",
        `${begin("jsonEncode")} const line = \`\${JSON.stringify(record)}\\n\`;`,
      );
      replace("lines.push(line);", `lines.push(line); ${end}`);
      replace(
        'const bytes = zlib.zstdCompressSync(Buffer.from(lines.join("")));',
        `
        ${begin("jsonEncode")}
        const raw = Buffer.from(lines.join(""));
        ${end}
        ${begin("compress")}
        const bytes = zlib.zstdCompressSync(raw);
        ${end}
      `,
      );
      const hash = 'const sha256 = createHash("sha256").update(bytes).digest("hex");';
      replace(hash, `${begin("hash")} ${hash} ${end}`);
      replace(
        "for (const record of decodeSessionColdRecords",
        `${begin("decodeVerify")} for (const record of decodeSessionColdRecords`,
      );
      replace(
        "publishEncodedSessionTranscriptArchive({",
        `${end} ${begin("publish")} publishEncodedSessionTranscriptArchive({`,
      );
      const verify = "verifyPublishedSessionColdArchive(plan.databaseOptions.path, chunk);";
      replace(verify, `${end} ${begin("fileVerify")} ${verify} ${end}`);
      replace(
        "if (!opened.found || chunks.length === 0)",
        "globalThis.coldSnapshotProfile.reading(false); if (!opened.found || chunks.length === 0)",
      );
      return {
        format: "module",
        source: stripTypeScriptTypes(original.slice(0, boundary) + source),
        shortCircuit: true,
      };
    },
  });
  return profile;
}
