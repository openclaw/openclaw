// Match pnpm's lockfile/src/yaml_documents.rs framing without requiring an
// install: security hooks and release bootstrap must read locks before YAML is available.
/** @param {string} source */
export function pnpmLockfileDocuments(source) {
  const text = source.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n");
  const start = "---\n";
  const separator = "\n---\n";
  if (!text.startsWith(start)) {
    if (text.includes(separator)) {
      throw new Error("pnpm-lock.yaml has an unexpected document separator");
    }
    return { environment: null, dependencies: text };
  }
  const boundary = text.indexOf(separator, start.length);
  if (boundary < 0 || text.includes(separator, boundary + separator.length)) {
    throw new Error("pnpm-lock.yaml must contain an environment document followed by dependencies");
  }
  return {
    environment: text.slice(start.length, boundary),
    dependencies: text.slice(boundary + separator.length),
  };
}

const SNAPSHOT_SECTIONS = new Set(["dependencies", "optionalDependencies"]);
const IMPORTER_SECTIONS = ["dependencies", "optionalDependencies"];
const LOCAL_REFERENCE_PREFIXES = ["file:", "link:", "portal:", "workspace:"];

function stripVersionDecorators(reference) {
  const openParenIndex = reference.indexOf("(");
  if (openParenIndex === -1) {
    return reference;
  }
  return reference.slice(0, openParenIndex);
}

export function parseSnapshotKey(snapshotKey) {
  let separatorIndex = -1;
  let parenDepth = 0;
  for (let index = 1; index < snapshotKey.length; index += 1) {
    const character = snapshotKey[index];
    if (character === "(") {
      parenDepth += 1;
      continue;
    }
    if (character === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (character === "@" && parenDepth === 0) {
      separatorIndex = index;
    }
  }
  if (separatorIndex <= 0) {
    throw new Error(`Unable to parse pnpm snapshot key "${snapshotKey}".`);
  }
  const packageName = snapshotKey.slice(0, separatorIndex);
  const reference = snapshotKey.slice(separatorIndex + 1);
  return {
    packageName,
    reference,
    version: stripVersionDecorators(reference),
  };
}

function isLocalReference(reference) {
  return LOCAL_REFERENCE_PREFIXES.some((prefix) => reference.startsWith(prefix));
}

function countIndentation(line) {
  let indentation = 0;
  while (indentation < line.length && line[indentation] === " ") {
    indentation += 1;
  }
  return indentation;
}

function isIgnorableYamlLine(trimmed) {
  return !trimmed || trimmed.startsWith("#");
}

function unquoteYamlString(value) {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('\\"', '"');
  }
  return value;
}

function parseYamlScalar(value) {
  return unquoteYamlString(value.trim());
}

function splitInlineYamlMapEntries(text) {
  const entries = [];
  let current = "";
  let quote = null;
  let depth = 0;

  for (const character of text) {
    if (quote) {
      current += character;
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "{" || character === "[" || character === "(") {
      depth += 1;
      current += character;
      continue;
    }
    if (character === "}" || character === "]" || character === ")") {
      depth = Math.max(0, depth - 1);
      current += character;
      continue;
    }
    if (character === "," && depth === 0) {
      const entry = current.trim();
      if (entry) {
        entries.push(entry);
      }
      current = "";
      continue;
    }
    current += character;
  }

  const entry = current.trim();
  if (entry) {
    entries.push(entry);
  }
  return entries;
}

function parseInlineYamlMap(rawValue) {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  const body = trimmed.slice(1, -1).trim();
  if (!body) {
    return {};
  }

  const result = {};
  for (const entry of splitInlineYamlMapEntries(body)) {
    const mapping = parseYamlMappingLine(entry);
    if (!mapping?.value) {
      continue;
    }
    result[mapping.key] = parseYamlScalar(mapping.value);
  }
  return result;
}

function findYamlMappingSeparator(line) {
  let quote = null;
  let depth = 0;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "{" || character === "[" || character === "(") {
      depth += 1;
      continue;
    }
    if (character === "}" || character === "]" || character === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (character !== ":" || depth !== 0) {
      continue;
    }

    const nextCharacter = line[index + 1];
    if (nextCharacter === undefined || /\s/u.test(nextCharacter)) {
      return index;
    }
  }

  return -1;
}

function parseYamlMappingLine(line) {
  const separatorIndex = findYamlMappingSeparator(line);
  if (separatorIndex === -1) {
    return null;
  }
  return {
    key: parseYamlScalar(line.slice(0, separatorIndex)),
    value: line.slice(separatorIndex + 1).trim(),
  };
}

// pnpm writes block mappings for these sections. Preserve leaf bytes as well as
// graph edges: integrity, platform and patch metadata can change without a version bump.
function mappingBlocks(source, indent = 0) {
  const lines = source.split(/\r?\n/u).filter((line) => !isIgnorableYamlLine(line.trim()));
  const result = new Map();
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (countIndentation(line) !== indent || line.includes("\t")) {
      throw new Error("Unsupported pnpm lockfile mapping indentation");
    }
    const entry = parseYamlMappingLine(line.trim());
    if (!entry || result.has(entry.key)) {
      throw new Error("Invalid or duplicate pnpm lockfile mapping");
    }
    const start = index++;
    while (index < lines.length && countIndentation(lines[index]) > indent) {
      index += 1;
    }
    result.set(entry.key, {
      value: entry.value,
      body: lines.slice(start + 1, index).join("\n"),
      source: lines
        .slice(start, index)
        .map((part) => part.trimEnd())
        .join("\n"),
    });
  }
  return result;
}

function children(block, indent) {
  if (!block) {
    return new Map();
  }
  if (block.value && block.value !== "{}") {
    throw new Error("Unsupported pnpm lockfile mapping value");
  }
  return mappingBlocks(block.body, indent);
}

export function parsePnpmLockfileSections(lockfileText) {
  // Security hooks and CI preflight both read this before dependency installation.
  const sections = mappingBlocks(lockfileText);
  const importerRoots = new Map();
  const importerMetadata = new Map();
  const importers = [];
  for (const [root, importer] of children(sections.get("importers"), 2)) {
    const groups = new Map();
    const metadata = [];
    for (const [section, group] of children(importer, 4)) {
      if (![...IMPORTER_SECTIONS, "devDependencies"].includes(section)) {
        metadata.push(group.source);
        continue;
      }
      const references = [];
      for (const [dependencyName, dependency] of children(group, 6)) {
        const nested = dependency.value ? parseInlineYamlMap(dependency.value) : null;
        const fields = dependency.value ? null : children(dependency, 8);
        const reference = nested
          ? nested.version
          : dependency.value
            ? parseYamlScalar(dependency.value)
            : parseYamlScalar(fields.get("version")?.value ?? "");
        if (!reference) {
          throw new Error(`Missing pnpm version for ${root}:${dependencyName}`);
        }
        references.push({
          dependencyName,
          reference,
          specifier: nested?.specifier ?? parseYamlScalar(fields?.get("specifier")?.value ?? ""),
        });
      }
      groups.set(section, references);
      if (IMPORTER_SECTIONS.includes(section)) {
        importers.push(...references);
      }
    }
    importerRoots.set(root, groups);
    importerMetadata.set(
      root,
      metadata.toSorted((left, right) => left.localeCompare(right)).join("\n"),
    );
  }
  const snapshotBlocks = children(sections.get("snapshots"), 2);
  const snapshots = Object.create(null);
  for (const [key, block] of snapshotBlocks) {
    const snapshot = Object.create(null);
    for (const [section, group] of children(block, 4)) {
      if (!SNAPSHOT_SECTIONS.has(section)) {
        continue;
      }
      snapshot[section] = Object.fromEntries(
        [...children(group, 6)].map(([name, dependency]) => {
          if (!dependency.value || dependency.body) {
            throw new Error(`Missing pnpm snapshot dependency for ${key}:${name}`);
          }
          return [name, parseYamlScalar(dependency.value)];
        }),
      );
    }
    snapshots[key] = snapshot;
  }
  return {
    hasImportersSection: sections.has("importers"),
    hasSnapshotsSection: sections.has("snapshots"),
    hasPackagesSection: sections.has("packages"),
    importers,
    importerRoots,
    importerMetadata,
    snapshots,
    snapshotBlocks,
    packageBlocks: children(sections.get("packages"), 2),
    globalBlocks: new Map(
      [...sections].filter(([key]) => !["importers", "snapshots", "packages"].includes(key)),
    ),
  };
}

export function resolveSnapshot({ dependencyName, reference, snapshots, includeLocal = false }) {
  if (!includeLocal && isLocalReference(reference)) {
    return null;
  }

  const directKey = `${dependencyName}@${reference}`;
  if (directKey in snapshots) {
    return {
      snapshotKey: directKey,
      ...parseSnapshotKey(directKey),
    };
  }

  if (reference in snapshots) {
    return {
      snapshotKey: reference,
      ...parseSnapshotKey(reference),
    };
  }

  if (reference.startsWith("npm:")) {
    const aliasKey = reference.slice(4);
    if (aliasKey in snapshots) {
      return {
        snapshotKey: aliasKey,
        ...parseSnapshotKey(aliasKey),
      };
    }
  }

  throw new Error(
    `Unable to resolve pnpm snapshot for dependency "${dependencyName}" with reference "${reference}".`,
  );
}
