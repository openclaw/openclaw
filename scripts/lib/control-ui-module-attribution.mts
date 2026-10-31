import fs from "node:fs";
import { SourceMap } from "node:module";
import path from "node:path";
import { gzip } from "pako";

type BootAsset = { file: string; type: string; gzipBytes: number };
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

function readAssetAttribution(distDir: string, file: string) {
  const assetPath = path.join(distDir, file);
  const code = fs.readFileSync(assetPath, "utf8");
  const modules = new Map<string, Buffer[]>();
  const unmapped: Buffer[] = [];
  const mapPath = `${assetPath}.map`;
  if (!fs.existsSync(mapPath)) {
    unmapped.push(Buffer.from(code));
    return { modules, unmapped, missingSourceMap: true };
  }
  const sourceMap = new SourceMap(JSON.parse(fs.readFileSync(mapPath, "utf8")));
  const mappingLines = sourceMap.payload.mappings.split(";");
  const sourceRoot = sourceMap.payload.sourceRoot ?? "";
  const lines = code.split("\n");
  for (const [lineIndex, line] of lines.entries()) {
    const columns = generatedColumns(mappingLines[lineIndex] ?? "");
    let previousColumn = 0;
    let lastMappingColumn = 0;
    let previousSource: string | undefined;
    const append = (end: number) => {
      if (end === previousColumn) {
        return;
      }
      const bytes = Buffer.from(line.slice(previousColumn, end));
      if (previousSource === undefined) {
        unmapped.push(bytes);
      } else {
        const parts = modules.get(previousSource) ?? [];
        parts.push(bytes);
        modules.set(previousSource, parts);
      }
      previousColumn = end;
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
      unmapped.push(Buffer.from("\n"));
    }
  }
  return { modules, unmapped, missingSourceMap: false };
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
          shippedGzipBytes: assets.reduce((sum, asset) => sum + asset.gzipBytes, 0),
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
