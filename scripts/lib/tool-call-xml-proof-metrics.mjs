// Proof-only instrumentation of built code; production files stay unchanged.
import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { getEnvironmentData, isMainThread, setEnvironmentData } from "node:worker_threads";

const names = ["parseMarkdownOwnership", "findMarkdownCodeRegions", "stripToolCallXmlTagsInternal"];
const key = "openclaw-tool-call-xml-proof";
let shared = getEnvironmentData(key);
if (!shared) {
  shared = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT * (names.length * 3 + 1));
  setEnvironmentData(key, shared);
}
const counters = new BigInt64Array(shared);
globalThis.openclawXmlProofCount = (name, text) => {
  const offset = names.indexOf(name) * 3;
  Atomics.add(counters, offset, 1n);
  Atomics.add(counters, offset + 1, BigInt(text.length));
  const length = BigInt(text.length);
  let current = Atomics.load(counters, offset + 2);
  while (current < length) {
    const actual = Atomics.compareExchange(counters, offset + 2, current, length);
    if (actual === current) {
      break;
    }
    current = actual;
  }
};
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.includes("/dist/") || !loaded.source) {
      return loaded;
    }
    const source =
      typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString();
    const signature = new RegExp(
      `function (${names.join("|")})\\(([\\w$]+)(?:,[^)]*)?\\)\\s*\\{`,
      "g",
    );
    if (!signature.test(source)) {
      return loaded;
    }
    Atomics.add(counters, names.length * 3, 1n);
    return {
      ...loaded,
      source: source.replace(
        signature,
        (match, name, argument) =>
          `${match}globalThis.openclawXmlProofCount(${JSON.stringify(name)}, ${argument});`,
      ),
    };
  },
});
if (isMainThread && process.env.OPENCLAW_XML_PROOF_METRICS) {
  process.on("SIGURG", () => {
    const functions = Object.fromEntries(
      names.map((name, index) => [
        name,
        {
          calls: Number(Atomics.load(counters, index * 3)),
          inputChars: Number(Atomics.load(counters, index * 3 + 1)),
          maxInputChars: Number(Atomics.load(counters, index * 3 + 2)),
        },
      ]),
    );
    writeFileSync(
      `${process.env.OPENCLAW_XML_PROOF_METRICS}.${process.pid}.json`,
      JSON.stringify({
        pid: process.pid,
        execPath: process.execPath,
        node: process.versions.node,
        instrumentedModuleCount: Number(Atomics.load(counters, names.length * 3)),
        cpu: process.cpuUsage(),
        functions,
      }),
    );
  });
}
