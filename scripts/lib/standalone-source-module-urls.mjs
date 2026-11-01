import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DIRECTORY = ".source-module-urls";
const VERSION = 3;
const slash = (value) => value.split(path.sep).join("/");
const hash = (value) => createHash("sha256").update(value).digest("hex");

function relativeFile(root, filename) {
  const relative = slash(path.relative(root, path.resolve(filename)));
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`Standalone module URL path escapes its owner: ${filename}`);
  }
  return relative;
}

function validRelative(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function validSource(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value
  );
}

function relativeSource(root, filename) {
  const relative = slash(path.relative(root, filename));
  if (!validSource(relative)) {
    throw new Error(`Invalid standalone module source: ${filename}`);
  }
  return relative;
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error("Standalone module URL metadata requires entry contracts");
  }
  const outputs = new Set();
  return entries
    .map((entry) => {
      if (
        !validRelative(entry?.output) ||
        !validSource(entry?.source) ||
        outputs.has(entry.output)
      ) {
        throw new Error("Invalid or duplicate standalone module URL entry contract");
      }
      outputs.add(entry.output);
      return { output: entry.output, source: entry.source };
    })
    .toSorted(
      (left, right) =>
        left.output.localeCompare(right.output) || left.source.localeCompare(right.source),
    );
}

function metadataName(entries) {
  return `${hash(JSON.stringify(entries))}.json`;
}

function parseMetadata(text) {
  const metadata = JSON.parse(text);
  if (
    metadata?.version !== VERSION ||
    !Array.isArray(metadata.chunks) ||
    !Array.isArray(metadata.unrenderedSources)
  ) {
    throw new Error("Invalid standalone module URL metadata");
  }
  const entries = normalizeEntries(metadata.entries);
  if (JSON.stringify(entries) !== JSON.stringify(metadata.entries)) {
    throw new Error("Noncanonical standalone module URL entry contracts");
  }
  const outputs = new Set();
  const renderedSources = new Set();
  for (const chunk of metadata.chunks) {
    if (
      !validRelative(chunk?.output) ||
      outputs.has(chunk.output) ||
      typeof chunk.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(chunk.sha256) ||
      (chunk.facadeSource !== null && !validSource(chunk.facadeSource)) ||
      !Array.isArray(chunk.sources) ||
      chunk.sources.some((source) => !validSource(source)) ||
      new Set(chunk.sources).size !== chunk.sources.length
    ) {
      throw new Error("Invalid standalone module URL chunk metadata");
    }
    outputs.add(chunk.output);
    for (const source of chunk.sources) {
      renderedSources.add(source);
    }
  }
  const unrenderedSources = metadata.unrenderedSources;
  if (
    unrenderedSources.some((source) => !validSource(source) || renderedSources.has(source)) ||
    new Set(unrenderedSources).size !== unrenderedSources.length ||
    JSON.stringify(unrenderedSources) !==
      JSON.stringify(unrenderedSources.toSorted((left, right) => left.localeCompare(right)))
  ) {
    throw new Error("Invalid standalone unrendered source metadata");
  }
  for (const entry of entries) {
    if (!outputs.has(entry.output)) {
      throw new Error(`Standalone module URL entry has no emitted chunk: ${entry.output}`);
    }
  }
  return metadata;
}

function readRegularFile(root, relative, fsImpl) {
  const filename = path.join(root, relative);
  const stat = fsImpl.lstatSync(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    fsImpl.realpathSync(filename) !== path.join(fsImpl.realpathSync(root), relative)
  ) {
    throw new Error(`Standalone module URL input is not an owned regular file: ${filename}`);
  }
  return fsImpl.readFileSync(filename);
}

/**
 * Record compiler-owned source bodies before source regions can be lost to minification.
 * @param {{ rootDir: string }} options
 * @returns {import("tsdown").TsdownPlugin}
 */
export function createStandaloneSourceModuleUrlPlugin({ rootDir }) {
  const sourceRoot = path.resolve(rootDir);
  let declaredEntries;
  let namedEntries;
  return {
    name: "openclaw:standalone-source-module-urls",
    outputOptions(options) {
      const nameEntry = options.entryFileNames;
      namedEntries = [];
      return {
        ...options,
        entryFileNames(...args) {
          const pattern = typeof nameEntry === "function" ? nameEntry.apply(this, args) : nameEntry;
          const chunk = args[0];
          if (typeof pattern !== "string" || /\[(?!name\])/u.test(pattern)) {
            throw new Error(`Standalone source entry has a non-stable output name: ${chunk.name}`);
          }
          namedEntries.push({
            name: chunk.name,
            source: chunk.facadeModuleId,
            output: pattern.replaceAll("[name]", chunk.name),
          });
          return pattern;
        },
      };
    },
    renderStart(_output, options) {
      declaredEntries = new Map(
        Object.entries(options.input).map(([name, source]) => [
          name,
          fs.realpathSync(path.resolve(options.cwd, source)),
        ]),
      );
    },
    generateBundle: {
      order: "post",
      handler(options, bundle) {
        if (!options.dir && !options.file) {
          throw new Error("Standalone module URL metadata requires an output directory");
        }
        const outputRoot = path.resolve(sourceRoot, options.dir ?? path.dirname(options.file));
        const emitted = Object.values(bundle).filter((chunk) => chunk.type === "chunk");
        const entries = normalizeEntries(
          emitted
            // Plugin-emitted companions can share both a root's name and source.
            .filter((chunk) => {
              if (!chunk.isEntry || declaredEntries.get(chunk.name) !== chunk.facadeModuleId) {
                return false;
              }
              return namedEntries.some(
                (entry) =>
                  entry.name === chunk.name &&
                  entry.source === chunk.facadeModuleId &&
                  entry.output === chunk.fileName,
              );
            })
            .map((chunk) => {
              if (
                !path.isAbsolute(chunk.facadeModuleId ?? "") ||
                chunk.facadeModuleId.includes("\0")
              ) {
                throw new Error(`Standalone entry lacks a file source owner: ${chunk.fileName}`);
              }
              return {
                output: relativeFile(outputRoot, path.join(outputRoot, chunk.fileName)),
                source: relativeSource(sourceRoot, chunk.facadeModuleId),
              };
            }),
        );
        for (const source of declaredEntries.values()) {
          if (!entries.some((entry) => entry.source === relativeSource(sourceRoot, source))) {
            throw new Error(`Standalone source entry has no emitted output: ${source}`);
          }
        }
        const chunks = emitted
          .map((chunk) => ({
            output: relativeFile(outputRoot, path.join(outputRoot, chunk.fileName)),
            sha256: hash(chunk.code),
            facadeSource:
              path.isAbsolute(chunk.facadeModuleId ?? "") &&
              !chunk.facadeModuleId.includes("\0") &&
              fs.existsSync(chunk.facadeModuleId)
                ? relativeSource(sourceRoot, fs.realpathSync(chunk.facadeModuleId))
                : null,
            sources: [
              ...new Set(
                chunk.moduleIds.flatMap((id) => {
                  if (
                    !path.isAbsolute(id) ||
                    id.includes("\0") ||
                    !(chunk.modules[id]?.renderedLength > 0)
                  ) {
                    return [];
                  }
                  const relative = slash(path.relative(sourceRoot, id));
                  return validSource(relative) ? [relative] : [];
                }),
              ),
            ].toSorted((left, right) => left.localeCompare(right)),
          }))
          .toSorted((left, right) => left.output.localeCompare(right.output));
        const renderedSources = new Set(chunks.flatMap((chunk) => chunk.sources));
        // Loaded modules may disappear entirely during tree shaking. Absence from
        // chunks alone cannot distinguish them from external or unknown modules.
        const unrenderedSources = [
          ...new Set(
            [...this.getModuleIds()].flatMap((id) => {
              if (
                !path.isAbsolute(id) ||
                id.includes("\0") ||
                typeof this.getModuleInfo(id)?.code !== "string" ||
                !fs.existsSync(id)
              ) {
                return [];
              }
              const source = relativeSource(sourceRoot, fs.realpathSync(id));
              return renderedSources.has(source) ? [] : [source];
            }),
          ),
        ].toSorted((left, right) => left.localeCompare(right));
        const metadata = { version: VERSION, entries, chunks, unrenderedSources };
        parseMetadata(JSON.stringify(metadata));
        this.emitFile({
          type: "asset",
          fileName: `${DIRECTORY}/${metadataName(entries)}`,
          source: `${JSON.stringify(metadata)}\n`,
        });
      },
    },
  };
}

/**
 * Read body locations separately from facade identities in one build context.
 * A facade can retain exports without rendering any of its own source body.
 * @param {{ sourceRoot: string, outputRoot: string, entries: { output: string, source: string }[], fsImpl?: typeof fs }} options
 * @returns {{ rendered: Map<string, string[]>, facades: Map<string, string[]> }}
 */
export function readStandaloneSourceModuleIdentities({
  sourceRoot: requestedSourceRoot,
  outputRoot: requestedOutputRoot,
  entries,
  fsImpl = fs,
}) {
  const sourceRoot = path.resolve(requestedSourceRoot);
  const outputRoot = path.resolve(requestedOutputRoot);
  const expected = normalizeEntries(
    entries.map((entry) => ({
      output: relativeFile(outputRoot, path.resolve(sourceRoot, entry.output)),
      source: relativeSource(
        sourceRoot,
        fsImpl.realpathSync(path.resolve(sourceRoot, entry.source)),
      ),
    })),
  );
  const metadataPath = `${DIRECTORY}/${metadataName(expected)}`;
  let metadata;
  try {
    metadata = parseMetadata(readRegularFile(outputRoot, metadataPath, fsImpl).toString("utf8"));
  } catch (cause) {
    throw new Error(
      `Missing or invalid source module URL metadata in ${outputRoot}. Run pnpm build.`,
      { cause },
    );
  }
  if (JSON.stringify(metadata.entries) !== JSON.stringify(expected)) {
    throw new Error(
      "Standalone module URL metadata does not match its build context. Run pnpm build.",
    );
  }
  const result = new Map();
  const facades = new Map();
  for (const source of metadata.unrenderedSources) {
    result.set(path.join(sourceRoot, source), []);
  }
  for (const chunk of metadata.chunks) {
    if (hash(readRegularFile(outputRoot, chunk.output, fsImpl)) !== chunk.sha256) {
      throw new Error(
        `Standalone module URL chunk hash mismatch: ${chunk.output}. Run pnpm build.`,
      );
    }
    for (const source of chunk.sources) {
      const filename = path.join(sourceRoot, source);
      const targets = result.get(filename) ?? [];
      targets.push(relativeFile(sourceRoot, path.join(outputRoot, chunk.output)));
      result.set(filename, targets);
    }
    if (chunk.facadeSource !== null) {
      const filename = path.join(sourceRoot, chunk.facadeSource);
      const targets = facades.get(filename) ?? [];
      targets.push(relativeFile(sourceRoot, path.join(outputRoot, chunk.output)));
      facades.set(filename, targets);
    }
  }
  return { rendered: result, facades };
}

/**
 * Refresh each affected ledger once after its owning postbuild transform writes new bytes.
 * @param {{ outputRoot: string, rewrites: { filename: string, original: string | Uint8Array, rewritten: string | Uint8Array }[], fsImpl?: typeof fs }} options
 */
export function updateStandaloneSourceModuleUrlChunks({
  outputRoot: requestedOutputRoot,
  rewrites,
  fsImpl = fs,
}) {
  const outputRoot = path.resolve(requestedOutputRoot);
  const replacements = new Map();
  for (const { filename, original, rewritten } of rewrites) {
    const originalHash = hash(original);
    const rewrittenHash = hash(rewritten);
    if (originalHash === rewrittenHash) {
      continue;
    }
    const relative = relativeFile(outputRoot, path.resolve(outputRoot, filename));
    if (replacements.has(relative)) {
      throw new Error(`Duplicate standalone module URL rewrite: ${relative}`);
    }
    replacements.set(relative, { originalHash, rewrittenHash });
  }
  const directory = path.join(outputRoot, DIRECTORY);
  if (!replacements.size || !fsImpl.existsSync(directory)) {
    return 0;
  }
  const updates = [];
  const verified = new Set();
  for (const name of fsImpl
    .readdirSync(directory)
    .toSorted((left, right) => left.localeCompare(right))) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) {
      continue;
    }
    const metadata = parseMetadata(
      readRegularFile(outputRoot, `${DIRECTORY}/${name}`, fsImpl).toString("utf8"),
    );
    if (metadataName(metadata.entries) !== name) {
      throw new Error("Standalone module URL metadata filename does not match its entries");
    }
    let changed = false;
    for (const chunk of metadata.chunks) {
      const relative = chunk.output;
      const replacement = replacements.get(relative);
      if (!replacement) {
        continue;
      }
      if (chunk.sha256 !== replacement.originalHash) {
        throw new Error(`Standalone module URL original hash mismatch: ${chunk.output}`);
      }
      if (!verified.has(relative)) {
        if (hash(readRegularFile(outputRoot, relative, fsImpl)) !== replacement.rewrittenHash) {
          throw new Error(
            `Standalone module URL replacement bytes do not match written chunk: ${relative}`,
          );
        }
        verified.add(relative);
      }
      chunk.sha256 = replacement.rewrittenHash;
      changed = true;
    }
    if (changed) {
      updates.push({ name, metadata });
    }
  }
  for (const { name, metadata } of updates) {
    fsImpl.writeFileSync(path.join(directory, name), `${JSON.stringify(metadata)}\n`);
  }
  return updates.length;
}
