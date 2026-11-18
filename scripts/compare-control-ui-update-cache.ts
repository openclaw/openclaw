#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { isRecord } from "../packages/normalization-core/src/record-coerce.ts";

type Bytes = { raw: number; gzip: number; brotli: number };
type OfflineAsset = { path: string; integrity: string };
type OfflineBuild = {
  publicAssetVersion: string;
  publicAssets: string[];
  assets: OfflineAsset[];
  deferredAssets: OfflineAsset[];
};
type Asset = {
  path: string;
  logical: string;
  category: string;
  sha256: string;
  referenceNormalizedSha256: string;
  publicVersionNormalizedSha256: string;
  sizes: Bytes;
};
type ComparedAsset = Asset & { change: string; previousPath: string | null };
type ReferenceGraph = Map<string, string[]>;

function hash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function filesIn(directory: string, prefix = ""): string[] {
  return fs.readdirSync(path.join(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesIn(directory, relative) : entry.isFile() ? [relative] : [];
  });
}

function logicalName(file: string): string {
  return file.startsWith("assets/")
    ? file.replace(/-[\w-]{8}(\.[\w]+(?:\.map)?)$/u, "-HASH$1")
    : file;
}

function category(file: string): string {
  if (file.startsWith("fonts/")) {
    return "fonts";
  }
  if (file.startsWith("themes/")) {
    return "themes";
  }
  if (file.endsWith(".css")) {
    return "css";
  }
  if (file.startsWith("assets/locale-") && file.endsWith(".js")) {
    return "locale-js";
  }
  return file.endsWith(".js") ? "js" : "other";
}

function readOfflineBuild(directory: string): OfflineBuild {
  const source = fs.readFileSync(path.join(directory, "sw.js"), "utf8");
  const encoded = source.match(/^const OFFLINE_BOOT = (.+);$/mu)?.[1];
  if (!encoded) {
    throw new Error(`${directory}: missing emitted service-worker inventory`);
  }
  const value: unknown = JSON.parse(encoded);
  if (!isRecord(value)) {
    throw new Error("Invalid offline inventory");
  }
  const build = value;
  const assets = (input: unknown): OfflineAsset[] => {
    if (!Array.isArray(input)) {
      throw new Error("Invalid offline asset list");
    }
    return input.map((entry: unknown) => {
      if (!isRecord(entry)) {
        throw new Error("Invalid offline asset");
      }
      const asset = entry;
      if (typeof asset.path !== "string" || typeof asset.integrity !== "string") {
        throw new Error("Invalid offline asset identity");
      }
      return { path: asset.path, integrity: asset.integrity };
    });
  };
  if (typeof build.publicAssetVersion !== "string") {
    throw new Error("Invalid public asset version");
  }
  if (
    !Array.isArray(build.publicAssets) ||
    !build.publicAssets.every((file) => typeof file === "string")
  ) {
    throw new Error("Invalid public asset list");
  }
  return {
    publicAssetVersion: build.publicAssetVersion,
    publicAssets: build.publicAssets,
    assets: assets(build.assets),
    deferredAssets: assets(build.deferredAssets),
  };
}

function servedSizes(directory: string, file: string, raw: number): Bytes {
  // Match the bundled Gateway: public assets are identity responses even if a
  // similarly named sidecar exists; only hashed assets and sw.js use sidecars.
  const eligible = file.startsWith("assets/") || file === "sw.js";
  const size = (suffix: string) => {
    const sidecar = path.join(directory, `${file}${suffix}`);
    return eligible && fs.existsSync(sidecar) ? fs.statSync(sidecar).size : raw;
  };
  return { raw, gzip: size(".gz"), brotli: size(".br") };
}

function readBuild(directory: string) {
  const offline = readOfflineBuild(directory);
  const files = filesIn(directory);
  // Only exact emitted basenames can normalize. Include sourcemap references,
  // but never count map/sidecar bytes as browser downloads.
  const names = new Map(
    files
      .filter((file) => file.startsWith("assets/") && !/\.(?:gz|br)$/u.test(file))
      .map((file) => [path.posix.basename(file), path.posix.basename(logicalName(file))]),
  );
  const assets = new Map<string, Asset>();
  const referenceGraph: ReferenceGraph = new Map();
  const chunksByName = new Map(
    files
      .filter((file) => /^assets\/[^/]+-[\w-]{8}\.(?:js|css)$/u.test(file))
      .map((file) => [path.posix.basename(file), file]),
  );
  for (const file of files.toSorted()) {
    if (/\.(?:gz|br|map)$/u.test(file) || path.posix.basename(file).startsWith(".")) {
      continue;
    }
    const bytes = fs.readFileSync(path.join(directory, file));
    const textAsset = /\.(?:js|css|html|json|svg|webmanifest|txt)$/u.test(file);
    const normalized = textAsset
      ? bytes.toString("utf8").replace(/[\w.-]+/gu, (name) => names.get(name) ?? name)
      : bytes;
    if (chunksByName.get(path.posix.basename(file)) === file) {
      const references = new Set<string>();
      const source = bytes
        .toString("utf8")
        .replace(
          /(?:\/\/[#@]\s*sourceMappingURL=[^\r\n]*|\/\*[#@]\s*sourceMappingURL=[\s\S]*?\*\/)/gu,
          "",
        );
      for (const [name] of source.matchAll(/[\w.-]+/gu)) {
        const target = chunksByName.get(name);
        if (target) {
          references.add(target);
        }
      }
      referenceGraph.set(file, [...references].toSorted());
    }
    assets.set(file, {
      path: file,
      logical: logicalName(file),
      category: category(file),
      sha256: hash(bytes),
      referenceNormalizedSha256: hash(normalized),
      publicVersionNormalizedSha256: hash(
        typeof normalized === "string"
          ? normalized.replaceAll(`?v=${offline.publicAssetVersion}`, "?v=PUBLIC_VERSION")
          : normalized,
      ),
      sizes: servedSizes(directory, file, bytes.byteLength),
    });
  }
  return { assets, offline, referenceGraph };
}

function summarizeReferenceGraph(graph: ReferenceGraph) {
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const pending = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (file: string) => {
    const index = indices.size;
    indices.set(file, index);
    lowLinks.set(file, index);
    stack.push(file);
    pending.add(file);
    for (const target of graph.get(file) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(file, Math.min(lowLinks.get(file)!, lowLinks.get(target)!));
      } else if (pending.has(target)) {
        lowLinks.set(file, Math.min(lowLinks.get(file)!, indices.get(target)!));
      }
    }
    if (lowLinks.get(file) === index) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        pending.delete(member);
        component.push(member);
      } while (member !== file);
      if (component.length > 1 || graph.get(file)?.includes(file)) {
        cycles.push(component.toSorted());
      }
    }
  };
  for (const file of graph.keys()) {
    if (!indices.has(file)) {
      visit(file);
    }
  }
  return {
    nodes: Object.fromEntries(graph),
    edgeCount: [...graph.values()].reduce((count, references) => count + references.length, 0),
    stronglyConnectedComponents: cycles.toSorted((left, right) => right.length - left.length),
  };
}

function describePayloadRoots(graph: ReferenceGraph, assets: ComparedAsset[]) {
  const importers = new Map<string, string[]>();
  for (const [file, references] of graph) {
    for (const target of references) {
      const incoming = importers.get(target) ?? [];
      incoming.push(file);
      importers.set(target, incoming);
    }
  }
  return assets
    .filter(
      (asset) =>
        graph.has(asset.path) &&
        ["renamed-payload-change", "changed-stable-path", "added-or-ambiguous"].includes(
          asset.change,
        ),
    )
    .map((asset) => {
      const affected = new Set([asset.path]);
      for (const file of affected) {
        for (const importer of importers.get(file) ?? []) {
          affected.add(importer);
        }
      }
      return {
        path: asset.path,
        previousPath: asset.previousPath,
        change: asset.change,
        directReferrers: importers.get(asset.path) ?? [],
        reachableReferrers: [...affected].filter((file) => file !== asset.path).toSorted(),
      };
    });
}

function total(rows: Iterable<{ sizes: Bytes }>): Bytes {
  const result = { raw: 0, gzip: 0, brotli: 0 };
  for (const row of rows) {
    result.raw += row.sizes.raw;
    result.gzip += row.sizes.gzip;
    result.brotli += row.sizes.brotli;
  }
  return result;
}

function summarize(rows: ComparedAsset[]) {
  const groups = new Map<string, ComparedAsset[]>();
  for (const row of rows) {
    const group = groups.get(row.change) ?? [];
    group.push(row);
    groups.set(row.change, group);
  }
  return Object.fromEntries(
    [...groups].map(([change, assets]) => [change, { count: assets.length, ...total(assets) }]),
  );
}

function compareControlUiUpdateCache(baseDirectory: string, headDirectory: string) {
  const base = readBuild(baseDirectory);
  const head = readBuild(headDirectory);
  const logical = new Map<string, Asset[]>();
  for (const asset of base.assets.values()) {
    const group = logical.get(asset.logical) ?? [];
    group.push(asset);
    logical.set(asset.logical, group);
  }
  const compared = [...head.assets.values()].map((asset): ComparedAsset => {
    const samePath = base.assets.get(asset.path);
    const candidates = logical.get(asset.logical) ?? [];
    const identical = candidates.find((old) => old.sha256 === asset.sha256);
    const references = candidates.find(
      (old) => old.referenceNormalizedSha256 === asset.referenceNormalizedSha256,
    );
    let previous = samePath;
    let change: string;
    if (samePath?.sha256 === asset.sha256) {
      change = "identical-path-content";
    } else if (identical) {
      previous = identical;
      change = "renamed-identical-content";
    } else if (references) {
      previous = references;
      change = "renamed-hash-reference-only";
    } else if (samePath?.publicVersionNormalizedSha256 === asset.publicVersionNormalizedSha256) {
      change = "public-version-reference-only";
    } else if (samePath) {
      change = "changed-stable-path";
    } else if (candidates.length === 1) {
      previous = candidates[0];
      change = "renamed-payload-change";
    } else {
      change = "added-or-ambiguous";
    }
    return Object.assign(asset, { change, previousPath: previous?.path ?? null });
  });
  const byPath = new Map(compared.map((asset) => [asset.path, asset]));
  const priorUrls = new Map(
    [...base.offline.assets, ...base.offline.deferredAssets].map((asset) => [
      asset.path,
      asset.integrity,
    ]),
  );
  const offlineGroup = (assets: OfflineAsset[]) => {
    const rows = assets.map((asset) => {
      const file = asset.path.split("?")[0]!;
      const emitted = byPath.get(file);
      if (!emitted) {
        throw new Error(`Offline inventory references missing file: ${file}`);
      }
      return Object.assign({}, emitted, {
        url: asset.path,
        cachedByPreviousUrl: priorUrls.get(asset.path) === asset.integrity,
      });
    });
    const download = rows.filter((asset) => !asset.cachedByPreviousUrl);
    return {
      count: rows.length,
      cold: total(rows),
      updated: total(download),
      refetchCount: download.length,
      assets: rows,
    };
  };
  const publicUrl = (file: string, version: string) => `${file}?v=${encodeURIComponent(version)}`;
  const priorImmutable = new Map<string, string>();
  for (const asset of base.assets.values()) {
    if (asset.path.startsWith("assets/")) {
      priorImmutable.set(asset.path, asset.sha256);
    }
  }
  for (const file of base.offline.publicAssets) {
    const asset = base.assets.get(file);
    if (!asset) {
      throw new Error(`Public inventory references missing file: ${file}`);
    }
    priorImmutable.set(publicUrl(file, base.offline.publicAssetVersion), asset.sha256);
  }
  const immutableFiles = new Set([
    ...compared.filter((asset) => asset.path.startsWith("assets/")).map((asset) => asset.path),
    ...head.offline.publicAssets,
  ]);
  const immutable = [...immutableFiles].map((file) => {
    const asset = byPath.get(file);
    if (!asset) {
      throw new Error(`Public inventory references missing file: ${file}`);
    }
    const url = file.startsWith("assets/")
      ? file
      : publicUrl(file, head.offline.publicAssetVersion);
    return Object.assign({}, asset, {
      url,
      cachedByPreviousUrl: priorImmutable.get(url) === asset.sha256,
    });
  });
  const transfer = (rows: typeof immutable) => ({
    count: rows.length,
    cold: total(rows),
    updated: total(rows.filter((asset) => !asset.cachedByPreviousUrl)),
    refetchCount: rows.filter((asset) => !asset.cachedByPreviousUrl).length,
  });
  const revalidated = ["index.html", "sw.js"].map((file) => {
    const asset = byPath.get(file);
    if (!asset) {
      throw new Error(`Missing revalidated asset: ${file}`);
    }
    const changed = base.assets.get(file)?.sha256 !== asset.sha256;
    return {
      path: file,
      contentChanged: changed,
      cold: asset.sizes,
      updated: total(changed ? [asset] : []),
    };
  });
  return {
    schemaVersion: 1,
    baseDirectory: path.resolve(baseDirectory),
    headDirectory: path.resolve(headDirectory),
    publicVersions: {
      base: base.offline.publicAssetVersion,
      head: head.offline.publicAssetVersion,
    },
    referenceGraph: {
      // Literal filename references include dynamic imports and Vite's preload tables.
      // Cycles explain why independent payload changes invalidate the same chunk set.
      base: summarizeReferenceGraph(base.referenceGraph),
      head: summarizeReferenceGraph(head.referenceGraph),
      payloadRoots: describePayloadRoots(head.referenceGraph, compared),
    },
    all: summarize(compared),
    hashedAssets: summarize(compared.filter((asset) => asset.path.startsWith("assets/"))),
    javascript: summarize(
      compared.filter((asset) => asset.path.endsWith(".js") && asset.path !== "sw.js"),
    ),
    categories: Object.fromEntries(
      [...new Set(compared.map((asset) => asset.category))]
        .toSorted()
        .map((name) => [name, summarize(compared.filter((asset) => asset.category === name))]),
    ),
    offlineBoot: offlineGroup(head.offline.assets),
    offlineDeferred: offlineGroup(head.offline.deferredAssets),
    fullCache: {
      // This hypothetical fully populated immutable cache is distinct from a
      // real visit and excludes licenses and other unversioned public files.
      immutable: transfer(immutable),
      categories: Object.fromEntries(
        [...new Set(immutable.map((asset) => asset.category))]
          .toSorted()
          .map((name) => [name, transfer(immutable.filter((asset) => asset.category === name))]),
      ),
      revalidated,
      assets: immutable,
    },
    assets: compared,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      "base-dir": { type: "string" },
      "head-dir": { type: "string" },
      output: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help || !values["base-dir"] || !values["head-dir"]) {
    console.log(
      "Usage: node scripts/compare-control-ui-update-cache.ts --base-dir <build-A> --head-dir <build-B> [--output <report.json>]",
    );
    if (!values.help) {
      process.exitCode = 1;
    }
  } else {
    const report = compareControlUiUpdateCache(values["base-dir"], values["head-dir"]);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (values.output) {
      fs.mkdirSync(path.dirname(path.resolve(values.output)), { recursive: true });
      fs.writeFileSync(values.output, json);
    } else {
      process.stdout.write(json);
    }
  }
}
