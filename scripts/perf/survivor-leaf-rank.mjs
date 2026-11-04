/**
 * Rank SELF bytes in a V8 sampling heap profile, never inclusive stack totals:
 * node scripts/perf/survivor-leaf-rank.mjs capture.heapprofile --minutes 10 \
 *   --source-root /path/to/matching/built/repo [--top 30] [--format json|markdown]
 *
 * Use a survivor/major-collected capture; this tool cannot recover object generations
 * or types. The duration is the sampling window, excluding setup/snapshot work.
 * Source maps provide exact locations; tsdown regions plus unique declaration
 * names provide inferred function locations. Unmapped frames remain in the rank.
 */
import { existsSync, readFileSync } from "node:fs";
import { SourceMap } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    minutes: { type: "string" },
    "source-root": { type: "string" },
    top: { type: "string", default: "30" },
    format: { type: "string", default: "markdown" },
  },
});
const minutes = Number(values.minutes);
const top = Number(values.top);
if (
  positionals.length !== 1 ||
  !(minutes > 0 && Number.isFinite(minutes)) ||
  !Number.isSafeInteger(top) ||
  top < 1 ||
  !["json", "markdown"].includes(values.format)
) {
  throw new Error(
    "Usage: survivor-leaf-rank.mjs <profile> --minutes <positive duration> [--source-root <matching build>] [--top 30] [--format json|markdown]",
  );
}
const root = values["source-root"] ? path.resolve(values["source-root"]) : undefined;
const files = new Map();
const sourceLines = new Map();
const relative = (file) =>
  root && file.startsWith(`${root}${path.sep}`) ? path.relative(root, file) : file;

function localFile(url) {
  if (url.startsWith("file:")) {
    return fileURLToPath(url);
  }
  return path.isAbsolute(url) ? url : undefined;
}

function loadBuiltFile(file) {
  if (!files.has(file)) {
    if (!existsSync(file)) {
      files.set(file, null);
    } else {
      const text = readFileSync(file, "utf8");
      const mapReference = [...text.matchAll(/^\/\/# sourceMappingURL=(.+)$/gm)].at(-1)?.[1];
      const mapFile =
        mapReference && !mapReference.startsWith("data:")
          ? path.resolve(path.dirname(file), mapReference)
          : `${file}.map`;
      const mapPayload = mapReference?.startsWith("data:application/json;base64,")
        ? JSON.parse(Buffer.from(mapReference.split(",")[1], "base64").toString("utf8"))
        : existsSync(mapFile)
          ? JSON.parse(readFileSync(mapFile, "utf8"))
          : null;
      files.set(file, {
        lines: text.split("\n"),
        map: mapPayload ? new SourceMap(mapPayload) : null,
        mapDirectory: path.dirname(mapFile),
        sourceRoot: mapPayload?.sourceRoot ?? "",
      });
    }
  }
  return files.get(file);
}

function mapFrame(frame) {
  const built = {
    file: frame.url || "(native/unknown)",
    line: frame.lineNumber >= 0 ? frame.lineNumber + 1 : null,
    column: frame.columnNumber >= 0 ? frame.columnNumber + 1 : null,
  };
  const file = localFile(frame.url);
  const fallback = { source: { ...built }, mapping: "unmapped", built };
  if (!file || !root || frame.lineNumber < 0) {
    return fallback;
  }
  const data = loadBuiltFile(file);
  if (!data) {
    return fallback;
  }
  const origin = data.map?.findEntry(frame.lineNumber, Math.max(0, frame.columnNumber));
  if (origin?.originalSource && origin.generatedLine === frame.lineNumber) {
    const mapBase = pathToFileURL(`${data.mapDirectory}${path.sep}`);
    const sourceBase = data.sourceRoot
      ? new URL(`${data.sourceRoot.replace(/\/$/, "")}/`, mapBase)
      : mapBase;
    const sourceUrl = new URL(origin.originalSource, sourceBase).href;
    const original = localFile(sourceUrl) ?? sourceUrl;
    return {
      source: {
        file: relative(original),
        line: origin.originalLine + 1,
        column: origin.originalColumn + 1,
      },
      mapping: "source-map",
      built,
    };
  }
  if (file.startsWith(`${root}${path.sep}`) && !relative(file).includes("dist/")) {
    return { source: { ...built, file: relative(file) }, mapping: "source", built };
  }
  const regions = [];
  for (let i = 0; i <= frame.lineNumber && i < data.lines.length; i++) {
    const start = /^\/\/#region (.+)$/.exec(data.lines[i]);
    if (start) {
      regions.push(start[1]);
    } else if (data.lines[i].startsWith("//#endregion")) {
      regions.pop();
    }
  }
  const region = regions.at(-1);
  if (!region || !/^(src|packages|extensions)\//.test(region)) {
    return fallback;
  }
  const source = path.join(root, region);
  let line = null;
  if (frame.functionName && existsSync(source)) {
    if (!sourceLines.has(source)) {
      sourceLines.set(source, readFileSync(source, "utf8").split("\n"));
    }
    const name = frame.functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const declaration = new RegExp(
      `\\b(?:function\\s+${name}\\s*[<(]|(?:const|let)\\s+${name}\\s*[:=])`,
    );
    const matches = sourceLines
      .get(source)
      .flatMap((text, index) => (declaration.test(text) ? [index + 1] : []));
    if (matches.length === 1) {
      line = matches[0];
    }
  }
  return {
    source: { file: region, line, column: null },
    mapping: line === null ? "region-only" : "region+unique-declaration (inferred)",
    built,
  };
}

const parsed = JSON.parse(readFileSync(positionals[0], "utf8"));
const profile = parsed.profile ?? parsed;
if (!profile.head) {
  throw new Error("Expected a V8 sampling profile with a head node");
}
const groups = new Map();
const frameLocations = new Map();
const pending = [profile.head];
let totalSelfBytes = 0;
while (pending.length) {
  const node = pending.pop();
  for (const child of node.children) {
    pending.push(child);
  }
  if (!Number.isFinite(node.selfSize) || node.selfSize < 0) {
    throw new Error(`Invalid selfSize at node ${node.id}`);
  }
  totalSelfBytes += node.selfSize;
  if (node.selfSize === 0) {
    continue;
  }
  const frame = node.callFrame;
  const frameKey = JSON.stringify([
    frame.url,
    frame.lineNumber,
    frame.columnNumber,
    frame.functionName,
  ]);
  let location = frameLocations.get(frameKey);
  if (!location) {
    location = mapFrame(frame);
    frameLocations.set(frameKey, location);
  }
  const functionName = node.callFrame.functionName || "(anonymous)";
  const key = JSON.stringify([
    functionName,
    location.source,
    location.source.line === null ? location.built : null,
  ]);
  let group = groups.get(key);
  if (!group) {
    group = {
      functionName,
      ...location,
      selfBytes: 0,
      nodes: 0,
      objectType: "unknown (sampling profile has no type)",
    };
    groups.set(key, group);
  }
  group.selfBytes += node.selfSize;
  group.nodes++;
}
const rows = [...groups.values()]
  .toSorted((a, b) => b.selfBytes - a.selfBytes || a.functionName.localeCompare(b.functionName))
  .slice(0, top)
  .map((row) => Object.assign(row, { survivorMiBPerMinute: row.selfBytes / 1024 ** 2 / minutes }));
const report = {
  minutes,
  totalSelfBytes,
  totalSurvivorMiBPerMinute: totalSelfBytes / 1024 ** 2 / minutes,
  scope:
    "SELF survivor/major-collected estimates, not exact promotion. Capture semantics determine survival; types are unavailable. Source-map locations are mapped; declaration-name locations are inferred.",
  rows,
};
if (values.format === "json") {
  console.log(JSON.stringify(report, null, 2));
} else {
  const cell = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
  console.log(report.scope);
  console.log(
    `\nWindow: ${minutes} min; total self bytes: ${totalSelfBytes}; ${report.totalSurvivorMiBPerMinute.toFixed(3)} MiB/min.\n`,
  );
  console.log(
    "| Leaf function | Source file:line | Survivor/major-collected MiB/min | Mapping | Object type |",
  );
  console.log("|---|---|---:|---|---|---|");
  for (const row of rows) {
    const source = `${row.source.file}:${row.source.line ?? "?"}`;
    console.log(
      `| ${cell(row.functionName)} | ${cell(source)} | ${row.survivorMiBPerMinute.toFixed(3)} | ${cell(row.mapping)} | ${row.objectType} |`,
    );
  }
}
