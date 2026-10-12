// One dependency-free owner for working-tree and immutable Git changelog artifacts.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const VERSION =
  /^(?:Unreleased|\d{4}\.[1-9]\d*\.[1-9]\d*(?:-(?:(?:alpha|beta)\.[1-9]\d*|[1-9]\d*))?)$/u;
const INDEX_MARKER = "<!-- openclaw:split-changelog -->";

/** @typedef {{ rootDir: string, ref?: string }} ChangelogSource */

function normalizeVersion(version) {
  const normalized = typeof version === "string" ? version.replace(/^v/u, "") : "";
  if (!VERSION.test(normalized)) {
    throw new Error(`Invalid changelog version: ${version}`);
  }
  return normalized;
}

export function changelogEntryPath(version) {
  return `CHANGELOG/${normalizeVersion(version)}.md`;
}

function changelogRecordPath(version) {
  return `CHANGELOG/records/${normalizeVersion(version)}.md`;
}

export function isReleaseChangelogPath(file, { version } = {}) {
  if (file === "CHANGELOG.md") {
    return true;
  }
  if (version !== undefined) {
    return file === changelogEntryPath(version) || file === changelogRecordPath(version);
  }
  const match = /^CHANGELOG\/(?:records\/)?([^/]+)\.md$/u.exec(file);
  return Boolean(match && VERSION.test(match[1]));
}

function headings(markdown, level) {
  const result = [];
  let offset = 0;
  let fence;
  for (const segment of markdown.split(/(?<=\n)/u)) {
    const line = segment.replace(/\r?\n$/u, "");
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (!fence) {
        fence = marker;
      } else if (
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        /^ {0,3}(?:`+|~+)\s*$/u.test(line)
      ) {
        fence = undefined;
      }
    } else if (!fence && line.startsWith(`${"#".repeat(level)} `)) {
      result.push({ line, start: offset, end: offset + segment.length });
    }
    offset += segment.length;
  }
  return result;
}

function sections(markdown) {
  const entries = headings(markdown, 2);
  return entries.map((heading, index) => {
    const token = /^##\s+(\S+)/u.exec(heading.line)?.[1];
    return {
      version: token && VERSION.test(token) ? token : null,
      source: markdown.slice(heading.start, entries[index + 1]?.start ?? markdown.length),
      start: heading.start,
    };
  });
}

function recordFromSection(section) {
  const matches = headings(section, 3).filter(
    ({ line }) => line === "### Complete contribution record",
  );
  if (matches.length > 1) {
    throw new Error("Ambiguous Complete contribution record headings");
  }
  if (!matches.length) {
    return null;
  }
  const newline = section.includes("\r\n") ? "\r\n" : "\n";
  return `${section.slice(0, section.indexOf("\n") + 1)}${newline}${section.slice(matches[0].start)}`;
}

/** @param {ChangelogSource} source */
function sourceReader({ rootDir, ref }) {
  if (!rootDir) {
    throw new Error("rootDir is required for changelog reads");
  }
  const root = fs.realpathSync(rootDir);
  const git = (args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  if (ref !== undefined) {
    if (typeof ref !== "string" || !ref || ref.startsWith("-")) {
      throw new Error(`Invalid changelog Git ref: ${ref}`);
    }
    // Resolve once; all tree/blob reads use that immutable object, never a moving ref.
    const oid = git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
    const files = new Map(
      git(["ls-tree", "-rz", oid, "--", "CHANGELOG.md", "CHANGELOG/"])
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const [meta, name] = entry.split("\t");
          return [name, meta.split(" ")];
        }),
    );
    return {
      files: [...files.keys()],
      read(name) {
        const meta = files.get(name);
        if (!meta) {
          return null;
        }
        if (meta[0] !== "100644" && meta[0] !== "100755") {
          throw new Error(`Changelog artifact is not a regular Git file: ${name}`);
        }
        return git(["cat-file", "blob", meta[2]]);
      },
    };
  }
  const files = [];
  function walk(relative) {
    const absolute = path.join(root, relative);
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Changelog artifact cannot be a symlink: ${relative}`);
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute)) {
        walk(`${relative}/${entry}`);
      }
    } else if (stat.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`Changelog artifact is not a regular file: ${relative}`);
    }
  }
  walk("CHANGELOG.md");
  walk("CHANGELOG");
  return {
    files,
    read: (name) => (files.includes(name) ? fs.readFileSync(path.join(root, name), "utf8") : null),
  };
}

function layout(reader) {
  const index = reader.read("CHANGELOG.md");
  if (index === null) {
    throw new Error("Missing CHANGELOG.md");
  }
  const split =
    index.includes(INDEX_MARKER) || reader.files.some((name) => name.startsWith("CHANGELOG/"));
  if (split && sections(index).some(({ version }) => version)) {
    throw new Error(
      "Conflicting changelog authority: split artifacts and monolithic release sections",
    );
  }
  return { index, kind: split ? "split" : "legacy" };
}

function validateEntry(section, version, sourcePath, allowDuplicates = false) {
  const parsed = sections(section);
  if (
    !parsed.length ||
    (!allowDuplicates && parsed.length !== 1) ||
    parsed.some((entry) => entry.version !== version)
  ) {
    throw new Error(
      `Ambiguous or mismatched changelog section in ${sourcePath}; expected ${version}`,
    );
  }
}

export function changelogFormat(section) {
  return section.includes("<!-- openclaw-docs-mirror-v1") ? "docs-mirror" : "initial";
}

export function findChangelogSection(markdown, requestedVersion) {
  const version = normalizeVersion(requestedVersion);
  let matches = sections(markdown).filter((entry) => entry.version === version);
  if (!matches.length && version === "Unreleased") {
    matches = sections(markdown).filter(
      (entry) => entry.version && /^##[^\n]+\(Unreleased\)\r?$/mu.test(entry.source.split("\n")[0]),
    );
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous changelog version ${version}`);
  }
  return matches[0]?.source ?? null;
}

function readSplitArtifacts(reader, version, allowDuplicates = false) {
  const sourcePath = changelogEntryPath(version);
  const section = reader.read(sourcePath);
  if (section === null) {
    return null;
  }
  validateEntry(section, version, sourcePath, allowDuplicates);
  const recordPath = changelogRecordPath(version);
  const record = reader.read(recordPath);
  if (record !== null) {
    validateEntry(record, version, recordPath, allowDuplicates);
    if (sections(record).some((entry) => recordFromSection(entry.source) === null)) {
      throw new Error(`Missing contribution record in ${recordPath}`);
    }
  }
  const inlineRecord =
    sections(section)
      .map((entry) => recordFromSection(entry.source) ?? "")
      .join("") || null;
  if (changelogFormat(section) === "initial" && inlineRecord !== record) {
    throw new Error(`Contribution record differs from initial changelog for ${version}`);
  }
  if (changelogFormat(section) === "docs-mirror" && record === null) {
    throw new Error(`Missing frozen contribution record for docs mirror ${version}`);
  }
  return { sourcePath, section, recordPath: record === null ? null : recordPath, record };
}

function splitInventory(reader, releases) {
  for (const name of reader.files.filter((file) => /^CHANGELOG\/records\/[^/]+\.md$/u.test(file))) {
    if (!releases.includes(path.basename(name, ".md"))) {
      throw new Error(`Orphan contribution record: ${name}`);
    }
  }
  return releases.map((version) => readSplitArtifacts(reader, version, true));
}

function readRelease(reader, state, requestedVersion) {
  let version = requestedVersion;
  if (state.kind === "legacy") {
    const section = findChangelogSection(state.index, version);
    if (section === null) {
      return null;
    }
    version = sections(section)[0].version;
    const record = recordFromSection(section);
    return {
      version,
      sourcePath: "CHANGELOG.md",
      section,
      record,
      recordPath: record ? "CHANGELOG.md" : null,
      layout: "legacy",
      format: changelogFormat(section),
      preamble: state.index
        .slice(0, sections(state.index)[0]?.start ?? 0)
        .replace(/^\uFEFF/u, "")
        .trimEnd(),
    };
  }
  if (version === "Unreleased" && reader.read(changelogEntryPath(version)) === null) {
    const matches = versions(reader, state).filter((candidate) =>
      /^##[^\n]+\(Unreleased\)\r?$/mu.test(
        reader.read(changelogEntryPath(candidate)).split("\n")[0],
      ),
    );
    if (matches.length > 1) {
      throw new Error("Ambiguous numbered Unreleased changelog sections");
    }
    if (!matches.length) {
      return null;
    }
    version = matches[0];
  }
  const artifacts = readSplitArtifacts(reader, version);
  if (artifacts === null) {
    return null;
  }
  return {
    version,
    ...artifacts,
    layout: "split",
    format: changelogFormat(artifacts.section),
    preamble: "# Changelog",
  };
}

/** @param {ChangelogSource & { version: string }} params */
export function findReleaseChangelog(params) {
  const version = normalizeVersion(params.version);
  const reader = sourceReader(params);
  return readRelease(reader, layout(reader), version);
}

/** @param {ChangelogSource & { version: string }} params */
export function loadReleaseChangelog(params) {
  const result = findReleaseChangelog(params);
  if (!result) {
    throw new Error(`Missing changelog release section for ${params.version}`);
  }
  return result;
}

function newestFirst(a, b) {
  if (a === b) {
    return 0;
  }
  if (a === "Unreleased") {
    return -1;
  }
  if (b === "Unreleased") {
    return 1;
  }
  const [aBase, aSuffix = ""] = a.split("-");
  const [bBase, bSuffix = ""] = b.split("-");
  const baseOrder = bBase.localeCompare(aBase, "en", { numeric: true });
  if (baseOrder) {
    return baseOrder;
  }
  const rank = (suffix) => (suffix.startsWith("alpha") ? 0 : suffix.startsWith("beta") ? 1 : 2);
  return rank(bSuffix) - rank(aSuffix) || bSuffix.localeCompare(aSuffix, "en", { numeric: true });
}

function versions(reader, state) {
  const result =
    state.kind === "legacy"
      ? sections(state.index)
          .filter((entry) => entry.version)
          .map((entry) => entry.version)
      : reader.files
          .filter((name) => /^CHANGELOG\/[^/]+\.md$/u.test(name))
          .map((name) => normalizeVersion(path.basename(name, ".md")));
  return [...new Set(result)].toSorted(newestFirst);
}

/** @param {ChangelogSource & { recordsOnly?: boolean }} params */
export function loadChangelogCollection(params) {
  const reader = sourceReader(params);
  const state = layout(reader);
  if (state.kind === "legacy") {
    return sections(state.index)
      .filter((entry) => entry.version)
      .map((entry) => (params.recordsOnly ? (recordFromSection(entry.source) ?? "") : entry.source))
      .join("");
  }
  return splitInventory(reader, versions(reader, state))
    .map((entry) => {
      const section = params.recordsOnly ? entry.record : entry.section;
      if (section === null) {
        return "";
      }
      return section.endsWith("\n\n") ? section : `${section}\n\n`;
    })
    .join("");
}

function renderIndex(releases, hasDuplicates = false) {
  return [
    "# Changelog",
    "",
    INDEX_MARKER,
    "",
    "Release notes: https://docs.openclaw.ai/releases",
    "",
    "Each release has its complete changelog below. Audited contribution records are retained separately when available.",
    "",
    ...releases.map(
      (version) =>
        `- [${version}](${changelogEntryPath(version)}) · [Raw](https://github.com/openclaw/openclaw/raw/refs/heads/main/${changelogEntryPath(version)})`,
    ),
    ...(hasDuplicates
      ? [
          "",
          "Some historical files retain repeated version headings from the original changelog, in their original order. Automated release selection refuses those ambiguous versions.",
        ]
      : []),
    "",
  ].join("\n");
}

function hasDuplicateSections(reader, releases) {
  return releases.some((version) => sections(reader.read(changelogEntryPath(version))).length > 1);
}

function writeArtifact(rootDir, name, content) {
  const target = path.join(rootDir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

export function writeReleaseChangelog({ rootDir, version: requestedVersion, section }) {
  const version = normalizeVersion(requestedVersion);
  const reader = sourceReader({ rootDir });
  const state = layout(reader);
  if (state.kind !== "split") {
    throw new Error("Changelog writes require split layout; run release-changelog split first");
  }
  if (typeof section !== "string") {
    throw new Error("section must be Markdown text");
  }
  if (changelogFormat(section) !== "initial") {
    throw new Error("Initial changelog generation cannot write a docs mirror");
  }
  validateEntry(section, version, changelogEntryPath(version));
  const existing = readRelease(reader, state, version);
  if (existing?.format === "docs-mirror") {
    throw new Error(
      `Release ${version} is a published docs mirror; initial generation cannot overwrite it`,
    );
  }
  const record = recordFromSection(section);
  if (existing?.record && !record) {
    throw new Error(`Refusing to discard contribution record for ${version}`);
  }
  const ordered = [...new Set([...versions(reader, state), version])].toSorted(newestFirst);
  writeArtifact(rootDir, changelogEntryPath(version), section);
  if (record) {
    writeArtifact(rootDir, changelogRecordPath(version), record);
  }
  writeArtifact(
    rootDir,
    "CHANGELOG.md",
    renderIndex(ordered, hasDuplicateSections(reader, versions(reader, state))),
  );
  return loadReleaseChangelog({ rootDir, version });
}

/** @param {ChangelogSource} source */
export function checkChangelogLayout({ rootDir, ref }) {
  const reader = sourceReader({ rootDir, ref });
  const state = layout(reader);
  if (state.kind !== "split") {
    throw new Error("Expected split changelog layout");
  }
  const releases = versions(reader, state);
  if (!releases.length) {
    throw new Error("Split changelog has no releases");
  }
  splitInventory(reader, releases);
  if (state.index !== renderIndex(releases, hasDuplicateSections(reader, releases))) {
    throw new Error("CHANGELOG.md index is stale");
  }
  return {
    releases: releases.length,
    records: reader.files.filter((file) => /^CHANGELOG\/records\/[^/]+\.md$/u.test(file)).length,
  };
}

/**
 * @param {{ rootDir: string, check?: boolean }} options
 * @returns {{ releases: number, records: number, sections?: number, duplicates?: number }}
 */
export function splitChangelog({ rootDir, check = false }) {
  const reader = sourceReader({ rootDir });
  const state = layout(reader);
  if (state.kind === "split") {
    if (!check) {
      const releases = versions(reader, state);
      writeArtifact(
        rootDir,
        "CHANGELOG.md",
        renderIndex(releases, hasDuplicateSections(reader, releases)),
      );
    }
    return checkChangelogLayout({ rootDir });
  }
  const parsed = sections(state.index);
  if (!parsed.length || parsed.some((entry) => !entry.version)) {
    throw new Error("Unrecognized or missing release headings in legacy changelog");
  }
  const artifacts = new Map();
  let duplicates = 0;
  const counts = new Map();
  for (const entry of parsed) {
    const count = (counts.get(entry.version) ?? 0) + 1;
    counts.set(entry.version, count);
    if (count > 1) {
      duplicates++;
    }
    artifacts.set(
      changelogEntryPath(entry.version),
      (artifacts.get(changelogEntryPath(entry.version)) ?? "") + entry.source,
    );
    const record = recordFromSection(entry.source);
    if (record) {
      artifacts.set(
        changelogRecordPath(entry.version),
        (artifacts.get(changelogRecordPath(entry.version)) ?? "") + record,
      );
    }
  }
  const releases = versions(reader, state);
  artifacts.set("CHANGELOG.md", renderIndex(releases, duplicates > 0));
  const result = {
    sections: parsed.length,
    releases: releases.length,
    records: [...artifacts.keys()].filter((name) => name.startsWith("CHANGELOG/records/")).length,
    duplicates,
  };
  if (!check) {
    for (const [name, content] of artifacts) {
      writeArtifact(rootDir, name, content);
    }
    checkChangelogLayout({ rootDir });
  }
  return result;
}
