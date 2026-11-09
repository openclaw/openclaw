import fs from "node:fs";
import { SourceMap } from "node:module";
import path from "node:path";
import { gzip } from "pako";
import {
  scriptExecutionMask,
  type ScriptCoverageFunctions,
} from "./control-ui-script-coverage.mts";

type BootAsset = { file: string; type: string; servedGzipBytes: number };
type BootGraphs = Record<string, { assets: readonly BootAsset[] }>;
type ModuleBytes = { module: string; rawBytes: number; standaloneGzipBytes: number };

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Only the first VLQ field is needed to locate a generated range. Node owns
// decoding the source identity and the remaining source-map fields.
function generatedColumns(mappings: string): Array<{ column: number; mapped: boolean }> {
  let column = 0;
  return mappings
    .split(",")
    .filter(Boolean)
    .map((segment) => {
      let value = 0;
      let shift = 0;
      let digits = 0;
      for (const character of segment) {
        digits += 1;
        const digit = BASE64.indexOf(character);
        if (digit === -1) {
          throw new Error("Invalid base64 VLQ in Control UI source map");
        }
        value += (digit & 31) * 2 ** shift;
        if ((digit & 32) === 0) {
          break;
        }
        shift += 5;
      }
      column += (value & 1) === 1 ? -Math.floor(value / 2) : Math.floor(value / 2);
      // A one-field segment explicitly ends the previous source's range.
      return { column, mapped: digits < segment.length };
    });
}

function standaloneGzipBytes(parts: readonly Buffer[]): number {
  return parts.length === 0
    ? 0
    : gzip(Buffer.concat(parts), { level: 9, legacyHash: true, memLevel: 6 }).byteLength;
}

function moduleKey(sourceRoot: string, source: string): string {
  const normalized = path.posix
    .join(sourceRoot, source)
    .replace(/\\/gu, "/")
    .replace(/[?#].*$/u, "");
  const vendorIndex = normalized.lastIndexOf("/node_modules/");
  if (vendorIndex !== -1) {
    return normalized.slice(vendorIndex + 1);
  }
  return normalized.replace(/^(?:\.\.\/)+/u, "");
}

type ModuleSpan = { start: number; end: number; module?: string };

/** Generated columns and coverage offsets both use UTF-16, not UTF-8 bytes. */
function readAssetSpans(distDir: string, file: string) {
  const assetPath = path.join(distDir, file);
  const code = fs.readFileSync(assetPath, "utf8");
  const spans: ModuleSpan[] = [];
  const mapPath = `${assetPath}.map`;
  if (!fs.existsSync(mapPath)) {
    return { code, spans: [{ start: 0, end: code.length }], missingSourceMap: true };
  }
  const sourceMap = new SourceMap(JSON.parse(fs.readFileSync(mapPath, "utf8")));
  const mappingLines = sourceMap.payload.mappings.split(";");
  const sourceRoot = sourceMap.payload.sourceRoot ?? "";
  const lines = code.split("\n");
  let lineOffset = 0;
  for (const [lineIndex, line] of lines.entries()) {
    const columns = generatedColumns(mappingLines[lineIndex] ?? "");
    let previousColumn = 0;
    let lastMappingColumn = 0;
    let previousSource: string | undefined;
    const append = (end: number) => {
      if (end !== previousColumn) {
        spans.push({
          start: lineOffset + previousColumn,
          end: lineOffset + end,
          module: previousSource,
        });
        previousColumn = end;
      }
    };
    for (const { column, mapped } of columns) {
      if (column < lastMappingColumn || column > line.length) {
        throw new Error(`Invalid generated column in Control UI source map: ${file}`);
      }
      const entry = sourceMap.findEntry(lineIndex, column);
      const source =
        mapped && "originalSource" in entry && entry.originalSource
          ? moduleKey(sourceRoot, entry.originalSource)
          : undefined;
      if (source !== previousSource) {
        append(column);
        previousSource = source;
      }
      lastMappingColumn = column;
    }
    append(line.length);
    // A source-map range ends at its generated line; it does not own line breaks.
    if (lineIndex < lines.length - 1) {
      spans.push({ start: lineOffset + line.length, end: lineOffset + line.length + 1 });
    }
    lineOffset += line.length + 1;
  }
  return { code, spans, missingSourceMap: false };
}

function readAssetAttribution(distDir: string, file: string) {
  const { code, spans, missingSourceMap } = readAssetSpans(distDir, file);
  const modules = new Map<string, Buffer[]>();
  const unmapped: Buffer[] = [];
  for (const span of spans) {
    const bytes = Buffer.from(code.slice(span.start, span.end));
    if (span.module === undefined) {
      unmapped.push(bytes);
    } else {
      const parts = modules.get(span.module) ?? [];
      parts.push(bytes);
      modules.set(span.module, parts);
    }
  }
  return { modules, unmapped, missingSourceMap };
}

/** Attribute emitted JS ranges, never unbundled source or source-map contents. */
export function collectControlUiModuleAttribution(distDir: string, graphs: BootGraphs) {
  const cache = new Map<string, ReturnType<typeof readAssetAttribution>>();
  return Object.fromEntries(
    Object.entries(graphs).map(([route, graph]) => {
      const modules = new Map<string, Buffer[]>();
      const unmapped: Buffer[] = [];
      const missingSourceMaps: string[] = [];
      const assets = graph.assets.filter((asset) => asset.type === "js");
      for (const asset of assets) {
        let attribution = cache.get(asset.file);
        if (!attribution) {
          attribution = readAssetAttribution(distDir, asset.file);
          cache.set(asset.file, attribution);
        }
        if (attribution.missingSourceMap) {
          missingSourceMaps.push(asset.file);
        }
        unmapped.push(...attribution.unmapped);
        for (const [module, parts] of attribution.modules) {
          const combined = modules.get(module) ?? [];
          combined.push(...parts);
          modules.set(module, combined);
        }
      }
      const ranked: ModuleBytes[] = [...modules]
        .map(([module, parts]) => ({
          module,
          rawBytes: parts.reduce((sum, part) => sum + part.byteLength, 0),
          standaloneGzipBytes: standaloneGzipBytes(parts),
        }))
        .toSorted(
          (left, right) =>
            right.standaloneGzipBytes - left.standaloneGzipBytes ||
            left.module.localeCompare(right.module),
        );
      return [
        route,
        {
          shippedGzipBytes: assets.reduce((sum, asset) => sum + asset.servedGzipBytes, 0),
          mappedRawBytes: ranked.reduce((sum, module) => sum + module.rawBytes, 0),
          unmappedRawBytes: unmapped.reduce((sum, part) => sum + part.byteLength, 0),
          unmappedStandaloneGzipBytes: standaloneGzipBytes(unmapped),
          missingSourceMaps,
          modules: ranked,
        },
      ] as const;
    }),
  );
}

export function formatControlUiModuleAttribution(
  attribution: ReturnType<typeof collectControlUiModuleAttribution>,
): string {
  const lines = [
    "Control UI module attribution (top 30 per route):",
    "  Emitted JS source-map ranges; standalone gzip uses canonical Pako settings.",
    "  Module gzip sizes are non-additive: shared compression dictionaries belong to the shipped chunks.",
  ];
  for (const [route, graph] of Object.entries(attribution)) {
    lines.push(
      `  ${route}: ${graph.shippedGzipBytes} B shipped gzip; ${graph.mappedRawBytes} B mapped raw; ${graph.unmappedRawBytes} B unmapped raw (${graph.unmappedStandaloneGzipBytes} B standalone gzip)`,
      "    standalone gzip B | emitted raw B | module",
      ...graph.modules
        .slice(0, 30)
        .map(
          (module) => `    ${module.standaloneGzipBytes} | ${module.rawBytes} | ${module.module}`,
        ),
      ...graph.missingSourceMaps.map((file) => `    missing source map: ${file}`),
    );
  }
  return lines.join("\n");
}

export type ControlUiScriptCoverage = {
  url: string;
  loadedBytes: number;
  functions: ScriptCoverageFunctions;
};

export type CoverageInventoryScope =
  | "coverage cutoff"
  | "whole-run (may include later fetches)"
  | "V8 only";

type CoverageBytes = {
  loadedBytes: number;
  executedBytes: number;
  unusedBytes: number;
  fetchedOnlyBytes: number;
};

function emptyCoverageBytes(): CoverageBytes {
  return { loadedBytes: 0, executedBytes: 0, unusedBytes: 0, fetchedOnlyBytes: 0 };
}

function coverageAssetFile(url: string): string | undefined {
  const pathname = URL.parse(url)?.pathname;
  return pathname?.match(/(?:^|\/)(assets\/[^/]+\.m?js)$/u)?.[1];
}

/** Attribute exact emitted text; source-map sourcesContent is never measured. */
export function collectControlUiCoverageAttribution(
  distDir: string,
  coverage: readonly ControlUiScriptCoverage[],
  resources?: readonly { url: string; decodedBytes: number }[],
  inventoryScope: CoverageInventoryScope = resources
    ? "whole-run (may include later fetches)"
    : "V8 only",
) {
  const scripts = new Map<string, ControlUiScriptCoverage | undefined>();
  for (const entry of coverage) {
    const file = coverageAssetFile(entry.url);
    if (!file) {
      throw new Error(`Not a Control UI script asset: ${entry.url}`);
    }
    if (scripts.has(file)) {
      throw new Error(`Duplicate coverage asset: ${file}`);
    }
    scripts.set(file, entry);
  }
  for (const resource of resources ?? []) {
    const file = coverageAssetFile(resource.url);
    if (resource.decodedBytes > 0 && file && !scripts.has(file)) {
      scripts.set(file, undefined);
    }
  }
  const modules = new Map<string, CoverageBytes>();
  const unmapped = emptyCoverageBytes();
  const total = emptyCoverageBytes();
  const assets = [];
  const missingSourceMaps: string[] = [];
  for (const [file, entry] of scripts) {
    const { code, spans, missingSourceMap } = readAssetSpans(distDir, file);
    const loadedBytes = Buffer.byteLength(code);
    if (entry && entry.loadedBytes !== loadedBytes) {
      throw new Error(
        `Coverage/bundle byte mismatch for ${file}: ${entry.loadedBytes} != ${loadedBytes}`,
      );
    }
    for (const fn of entry?.functions ?? []) {
      for (const range of fn.ranges) {
        if (
          !Number.isInteger(range.startOffset) ||
          !Number.isInteger(range.endOffset) ||
          range.startOffset < 0 ||
          range.endOffset < range.startOffset ||
          range.endOffset > code.length
        ) {
          throw new Error(`Coverage range outside bundle text: ${file}`);
        }
      }
    }
    const executed = scriptExecutionMask(code.length, entry?.functions ?? []);
    const asset = { file, coverageObserved: entry !== undefined, ...emptyCoverageBytes() };
    if (missingSourceMap) {
      missingSourceMaps.push(file);
    }
    for (const span of spans) {
      const row =
        span.module === undefined ? unmapped : (modules.get(span.module) ?? emptyCoverageBytes());
      const bytes = Buffer.byteLength(code.slice(span.start, span.end));
      let executedBytes = 0;
      let start = span.start;
      for (let offset = span.start; offset <= span.end; offset++) {
        if (offset === span.end || executed[offset] !== executed[start]) {
          if (executed[start]) {
            executedBytes += Buffer.byteLength(code.slice(start, offset));
          }
          start = offset;
        }
      }
      for (const target of [row, asset, total]) {
        target.loadedBytes += bytes;
        target.executedBytes += executedBytes;
        target.unusedBytes += bytes - executedBytes;
        target.fetchedOnlyBytes += entry ? 0 : bytes;
      }
      if (span.module !== undefined) {
        modules.set(span.module, row);
      }
    }
    assets.push(asset);
  }
  const ranked = [...modules]
    .map(([module, bytes]) => ({
      module,
      loadedBytes: bytes.loadedBytes,
      executedBytes: bytes.executedBytes,
      unusedBytes: bytes.unusedBytes,
      fetchedOnlyBytes: bytes.fetchedOnlyBytes,
    }))
    .toSorted(
      (left, right) =>
        right.unusedBytes - left.unusedBytes || left.module.localeCompare(right.module),
    );
  return {
    ...total,
    inventoryScope,
    assets,
    modules: ranked,
    unmapped,
    missingSourceMaps,
  };
}

export function formatControlUiCoverageAttribution(
  report: ReturnType<typeof collectControlUiCoverageAttribution>,
): string {
  const lines = [
    "Control UI coverage attribution (top 30 modules by unused emitted UTF-8 bytes):",
    `  ${report.loadedBytes} B loaded; ${report.executedBytes} B executed; ${report.unusedBytes} B unused; ${report.fetchedOnlyBytes} B fetched without a V8 coverage entry`,
    "  Coverage describes executed ranges, not CPU time or a safe-to-delete verdict.",
    `  Inventory scope: ${report.inventoryScope}.`,
    ...(report.inventoryScope === "V8 only"
      ? ["  No HTTP inventory: fetched-only scripts are excluded."]
      : []),
    "  unused B | loaded B | executed B | fetched-only B | module",
    ...report.modules
      .slice(0, 30)
      .map(
        (row) =>
          `  ${row.unusedBytes} | ${row.loadedBytes} | ${row.executedBytes} | ${row.fetchedOnlyBytes} | ${row.module}`,
      ),
    `  ${report.unmapped.unusedBytes} | ${report.unmapped.loadedBytes} | ${report.unmapped.executedBytes} | ${report.unmapped.fetchedOnlyBytes} | <unmapped>`,
    ...report.missingSourceMaps.map((file) => `  missing source map: ${file}`),
  ];
  return lines.join("\n");
}
