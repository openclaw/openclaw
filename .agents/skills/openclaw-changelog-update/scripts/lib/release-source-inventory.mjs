import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import {
  isoSecond,
  summarizeTeamUniverseMembers,
  summarizeTeamUniverseRecords,
  teamUniverseWindowQuery,
} from "./github-team-inventory.mjs";

const objectIdPattern = /^[0-9a-f]{40}$/;
const maxBuffer = 128 * 1024 * 1024;
const gitApplyTimeoutMs = 60_000;
const repositoryRedirectVariables = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
];
const globalPathspecVariables = [
  "GIT_GLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
  "GIT_LITERAL_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
];

function fail(message) {
  throw new Error(message);
}

function canonicalDiffArgs(command, unified = 3) {
  return [
    "-c",
    `core.attributesFile=${devNull}`,
    "-c",
    "core.quotePath=true",
    "-c",
    "diff.suppressBlankEmpty=false",
    command,
    `--unified=${unified}`,
    "--inter-hunk-context=0",
    "--diff-algorithm=myers",
    "--no-indent-heuristic",
    "--no-textconv",
    "--no-ext-diff",
    "--no-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--no-relative",
    `-O${devNull}`,
  ];
}

export function canonicalGitEnvironment(overrides = {}) {
  const environment = { ...process.env, ...overrides };
  for (const variable of [...repositoryRedirectVariables, ...globalPathspecVariables]) {
    delete environment[variable];
  }
  return {
    ...environment,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    LC_ALL: "C",
    NO_COLOR: "1",
  };
}

function git(cwd, args, { input } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: canonicalGitEnvironment(),
    input,
    maxBuffer,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

function gitBuffer(cwd, args, { input } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: null,
    env: canonicalGitEnvironment(),
    input,
    maxBuffer,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    fail(
      `git ${args.join(" ")} failed: ${
        result.stderr?.toString("utf8").trim() || result.signal || result.status
      }`,
    );
  }
  return result.stdout;
}

function resolveCommit(cwd, ref) {
  const commit = git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  if (!objectIdPattern.test(commit)) {
    fail(`${ref} did not resolve to an immutable commit`);
  }
  return commit;
}

function assertCanonicalRepository(cwd) {
  if (git(cwd, ["rev-parse", "--is-shallow-repository"]).trim() !== "false") {
    fail("release source inventory refuses shallow Git repositories");
  }
  if (git(cwd, ["for-each-ref", "--format=%(refname)", "refs/replace"]).trim() !== "") {
    fail("release source inventory refuses Git replacement refs");
  }
  const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  try {
    if (readFileSync(join(commonDir, "info", "grafts")).length > 0) {
      fail("release source inventory refuses a non-empty Git grafts file");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  try {
    if (readFileSync(join(commonDir, "info", "attributes")).length > 0) {
      fail("release source inventory refuses a non-empty Git info/attributes file");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function parseIdentity(value, label, commit) {
  const match = value.match(/^(?<name>.*) <(?<email>[^>]*)> (?<timestamp>\d+) [+-]\d{4}$/);
  if (!match?.groups) {
    fail(`commit ${commit} has a malformed ${label} header`);
  }
  return {
    email: match.groups.email,
    name: match.groups.name,
    timestamp: Number(match.groups.timestamp) * 1000,
  };
}

function parseRawCommit(commit, content) {
  const separator = content.indexOf("\n\n");
  if (separator < 0) {
    fail(`commit ${commit} has malformed raw content`);
  }
  const headerLines = content.slice(0, separator).split("\n");
  const headers = [];
  for (const line of headerLines) {
    if (line.startsWith(" ")) {
      if (headers.length === 0) {
        fail(`commit ${commit} has malformed continued headers`);
      }
      headers[headers.length - 1] += `\n${line}`;
    } else {
      headers.push(line);
    }
  }
  const values = (name) =>
    headers
      .filter((line) => line.startsWith(`${name} `))
      .map((line) => line.slice(name.length + 1));
  const trees = values("tree");
  const parents = values("parent");
  const authors = values("author");
  const committers = values("committer");
  if (
    trees.length !== 1 ||
    !objectIdPattern.test(trees[0]) ||
    parents.some((parent) => !objectIdPattern.test(parent)) ||
    authors.length !== 1 ||
    committers.length !== 1
  ) {
    fail(`commit ${commit} has malformed raw topology or identity headers`);
  }
  const message = content.slice(separator + 2);
  const [subject = ""] = message.split(/\r?\n/, 1);
  const firstLineEnd = message.indexOf("\n");
  const body = firstLineEnd < 0 ? "" : message.slice(firstLineEnd + 1).trimStart();
  return {
    author: parseIdentity(authors[0], "author", commit),
    body,
    commit,
    committer: parseIdentity(committers[0], "committer", commit),
    message,
    parents,
    subject,
    tree: trees[0],
  };
}

function readCommitBatch(cwd, commits) {
  if (commits.length === 0) {
    return new Map();
  }
  const output = gitBuffer(cwd, ["cat-file", "--batch"], {
    input: Buffer.from(`${commits.join("\n")}\n`),
  });
  const records = new Map();
  let offset = 0;
  for (const requested of commits) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) {
      fail(`git cat-file omitted commit ${requested}`);
    }
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const match = header.match(/^(?<commit>[0-9a-f]{40}) (?<type>\S+) (?<size>\d+)$/);
    if (!match?.groups || match.groups.commit !== requested || match.groups.type !== "commit") {
      fail(`git cat-file could not read commit ${requested}`);
    }
    const size = Number(match.groups.size);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || contentEnd > output.length) {
      fail(`git cat-file returned an invalid size for commit ${requested}`);
    }
    const content = output.subarray(contentStart, contentEnd).toString("utf8");
    records.set(requested, parseRawCommit(requested, content));
    offset = contentEnd + 1;
  }
  return records;
}

function readRawClosure(cwd, tips) {
  const records = new Map();
  const prime = git(cwd, ["rev-list", ...tips])
    .trim()
    .split("\n")
    .filter(Boolean);
  let pending = [...new Set([...tips, ...prime])];
  while (pending.length > 0) {
    const batch = pending.filter((commit) => !records.has(commit)).toSorted();
    if (batch.length === 0) {
      break;
    }
    const loaded = readCommitBatch(cwd, batch);
    for (const [commit, record] of loaded) {
      records.set(commit, record);
    }
    pending = [...loaded.values()].flatMap((record) => record.parents);
  }
  return records;
}

function ancestorsOf(graph, tip) {
  const ancestors = new Set();
  const pending = [tip];
  while (pending.length > 0) {
    const commit = pending.pop();
    if (ancestors.has(commit)) {
      continue;
    }
    const record = graph.get(commit);
    if (!record) {
      fail(`raw Git graph is missing commit ${commit}`);
    }
    ancestors.add(commit);
    pending.push(...record.parents);
  }
  return ancestors;
}

function rawMergeBase(graph, left, right) {
  const leftAncestors = ancestorsOf(graph, left);
  const rightAncestors = ancestorsOf(graph, right);
  const common = new Set([...leftAncestors].filter((commit) => rightAncestors.has(commit)));
  const commonChildren = new Set();
  for (const commit of common) {
    for (const parent of graph.get(commit).parents) {
      if (common.has(parent)) {
        commonChildren.add(parent);
      }
    }
  }
  const mergeBases = [...common].filter((commit) => !commonChildren.has(commit)).toSorted();
  if (mergeBases.length !== 1) {
    fail(`${left} and ${right} have ${mergeBases.length} raw merge bases`);
  }
  return mergeBases[0];
}

function oldestFirst(graph, commits) {
  const members = new Set(commits);
  const children = new Map();
  const parentCounts = new Map();
  for (const commit of members) {
    const parents = graph.get(commit).parents.filter((parent) => members.has(parent));
    parentCounts.set(commit, parents.length);
    for (const parent of parents) {
      const values = children.get(parent) ?? [];
      values.push(commit);
      children.set(parent, values);
    }
  }
  const compare = (left, right) =>
    graph.get(left).committer.timestamp - graph.get(right).committer.timestamp ||
    left.localeCompare(right);
  const ready = [...members].filter((commit) => parentCounts.get(commit) === 0).sort(compare);
  const ordered = [];
  while (ready.length > 0) {
    const commit = ready.shift();
    ordered.push(commit);
    for (const child of children.get(commit) ?? []) {
      const remaining = parentCounts.get(child) - 1;
      parentCounts.set(child, remaining);
      if (remaining === 0) {
        ready.push(child);
        ready.sort(compare);
      }
    }
  }
  if (ordered.length !== members.size) {
    fail("raw Git graph contains a cycle");
  }
  return ordered;
}

function localReferencesIn(text) {
  const references = [];
  for (const match of text.matchAll(
    /(?<![A-Za-z0-9_.&-])(?:(?<owner>[A-Za-z0-9_.-]+)\/(?<name>[A-Za-z0-9_.-]+))?#(?<number>\d+)/g,
  )) {
    const repository = match.groups?.owner
      ? `${match.groups.owner}/${match.groups.name}`.toLowerCase()
      : undefined;
    if (!repository || repository === "openclaw/openclaw") {
      references.push(Number(match.groups.number));
    }
  }
  return [...new Set(references)];
}

export function explicitPullRequestReferences(subject, body) {
  const references = [];
  const trailing = subject.match(/\((?:(?:openclaw\/openclaw)?#(?<number>\d+))\)\s*$/i);
  if (trailing?.groups?.number) {
    references.push(Number(trailing.groups.number));
  }
  const merge = subject.match(/^Merge pull request #(?<number>\d+)\b/i);
  if (merge?.groups?.number) {
    references.push(Number(merge.groups.number));
  }
  if (/^Reapply\s+"/i.test(subject)) {
    references.push(...localReferencesIn(subject));
  }
  const referenceList = String.raw`(?:(?:openclaw\/openclaw)?#\d+)(?:\s*(?:,|and)\s*(?:(?:openclaw\/openclaw)?#\d+))*`;
  const directive = new RegExp(
    String.raw`^(?:(?:pull request|pr|source-pr|cherry-pick(?:ed)? from)\s*:?\s*${referenceList}|backport(?:ed)? (?:from|of)\s+${referenceList}(?:\s+to\s+\S+)?)\s*[.!]?$`,
    "i",
  );
  for (const line of body.split(/\r?\n/).map((value) => value.trim())) {
    if (directive.test(line)) {
      references.push(...localReferencesIn(line));
    }
  }
  return [...new Set(references)].toSorted((left, right) => left - right);
}

function requiredPullRequestReferences(subject, body) {
  const references = [];
  const merge = subject.match(/^Merge pull request #(?<number>\d+)\b/i);
  if (merge?.groups?.number) {
    references.push(Number(merge.groups.number));
  }
  if (/^Reapply\s+"/i.test(subject)) {
    references.push(...localReferencesIn(subject));
  }
  const referenceList = String.raw`(?:(?:openclaw\/openclaw)?#\d+)(?:\s*(?:,|and)\s*(?:(?:openclaw\/openclaw)?#\d+))*`;
  const directive = new RegExp(
    String.raw`^(?:(?:pull request|pr|source-pr|cherry-pick(?:ed)? from)\s*:?\s*${referenceList}|backport(?:ed)? (?:from|of)\s+${referenceList}(?:\s+to\s+\S+)?)\s*[.!]?$`,
    "i",
  );
  for (const line of body.split(/\r?\n/).map((value) => value.trim())) {
    if (directive.test(line)) {
      references.push(...localReferencesIn(line));
    }
  }
  return new Set(references);
}

function cherryPickOrigins(message) {
  return [...message.matchAll(/^\(cherry picked from commit ([0-9a-f]{40})\)$/gim)].map((match) =>
    match[1].toLowerCase(),
  );
}

function adaptationOrigins(message) {
  return [...message.matchAll(/^Partial backport of ([0-9a-f]{40})(?:[.;]|$)/gim)].map((match) =>
    match[1].toLowerCase(),
  );
}

function revertMessageParts(message) {
  const paragraphs = message
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim());
  const isRevert = /^(?:[a-z][a-z0-9-]*(?:\([^)]+\))?!?:\s*)?revert\b/i.test(paragraphs[0] ?? "");
  return { isRevert, paragraphs };
}

function standardRevertMarkers(message) {
  const { isRevert, paragraphs } = revertMessageParts(message);
  const markers = [];
  for (const [index, paragraph] of paragraphs.entries()) {
    const hash = paragraph.match(/^This reverts commit ([0-9a-f]{7,40})\.$/i)?.[1];
    if (!hash) {
      continue;
    }
    const squashSubject = paragraphs[index - 1]?.match(/^\*\s+Revert\s+"(?<subject>.+)"$/i)?.groups
      ?.subject;
    // GitHub squash messages can embed a reverted intermediate commit. Its
    // marker follows the corresponding bullet and does not revert the squash.
    if (!isRevert && squashSubject) {
      continue;
    }
    markers.push({ hash: hash.toLowerCase(), squashSubject });
  }
  return markers.filter(
    (marker, index) =>
      markers.findIndex(
        (candidate) =>
          candidate.hash === marker.hash && candidate.squashSubject === marker.squashSubject,
      ) === index,
  );
}

export function standardRevertedHashes(message) {
  return [...new Set(standardRevertMarkers(message).map((marker) => marker.hash))];
}

export function standardRevertedHash(message) {
  return standardRevertedHashes(message)[0];
}

function revertedCommits(message) {
  return standardRevertedHashes(message).filter((hash) => objectIdPattern.test(hash));
}

function isRevertMessage(message) {
  return revertMessageParts(message).isRevert;
}

function verifiedRevertEvidence(cwd, graph, record, target, associatedPullRequests) {
  if (exactPatchEquivalent(cwd, graph, target, record.commit, { inverse: true })) {
    return { proofMethod: "exact-inverse-patch" };
  }
  const targetRecord = graph.get(target);
  const marker = standardRevertMarkers(record.message).find(
    (candidate) => candidate.hash === target && candidate.squashSubject === targetRecord?.subject,
  );
  if (!marker || associatedPullRequests.length === 0) {
    return undefined;
  }
  return {
    associatedPullRequests: [...associatedPullRequests].toSorted((left, right) => left - right),
    proofMethod: "subject-bound-github-squash",
    quotedSubject: marker.squashSubject,
  };
}

function commitPatch(cwd, graph, commit) {
  const record = graph.get(commit);
  if (!record || record.parents.length !== 1) {
    return undefined;
  }
  return commitFirstParentPatch(cwd, graph, commit);
}

function commitFirstParentPatch(cwd, graph, commit) {
  const record = graph.get(commit);
  if (!record || record.parents.length === 0) {
    return undefined;
  }
  const patch = git(cwd, [
    ...canonicalDiffArgs("diff"),
    "--binary",
    "--full-index",
    "--no-color",
    record.parents[0],
    commit,
    "--",
  ]);
  if (patch === "") {
    return undefined;
  }
  const patchId = git(cwd, ["patch-id", "--stable"], { input: patch }).trim().split(/\s+/)[0];
  return {
    diffSha256: createHash("sha256").update(patch).digest("hex"),
    parent: record.parents[0],
    patch,
    patchId,
  };
}

function commitRangePatch(cwd, baseCommit, headCommit) {
  const patch = git(cwd, [
    ...canonicalDiffArgs("diff"),
    "--binary",
    "--full-index",
    "--no-color",
    baseCommit,
    headCommit,
    "--",
  ]);
  if (patch === "") {
    return undefined;
  }
  return {
    diffSha256: createHash("sha256").update(patch).digest("hex"),
    parent: baseCommit,
    patch,
    patchId: git(cwd, ["patch-id", "--stable"], { input: patch }).trim().split(/\s+/)[0],
  };
}

function uniqueMergeBase(cwd, left, right, label) {
  const result = spawnSync("git", ["merge-base", "--all", left, right], {
    cwd,
    encoding: "utf8",
    env: canonicalGitEnvironment(),
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const commits = result.stdout.trim().split(/\s+/).filter(Boolean);
  if (result.status !== 0 || commits.length !== 1 || !objectIdPattern.test(commits[0])) {
    fail(`${label} does not have exactly one immutable merge base`);
  }
  return commits[0];
}

function isAncestor(cwd, ancestor, descendant) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd,
    encoding: "utf8",
    env: canonicalGitEnvironment(),
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  fail(
    `git merge-base --is-ancestor ${ancestor} ${descendant} failed: ${
      result.stderr?.trim() || result.signal || result.status
    }`,
  );
}

function extendGraphWithCommitsAndParents(cwd, graph, commits) {
  const missing = [...new Set(commits)].filter((commit) => !graph.has(commit)).toSorted();
  const records = readCommitBatch(cwd, missing);
  for (const [commit, record] of records) {
    graph.set(commit, record);
  }
  const missingParents = [
    ...new Set(
      [...records.values()]
        .flatMap((record) => record.parents)
        .filter((commit) => !graph.has(commit)),
    ),
  ].toSorted();
  for (const [commit, record] of readCommitBatch(cwd, missingParents)) {
    graph.set(commit, record);
  }
}

function commitRangePathPatch(cwd, baseCommit, headCommit, path) {
  const patch = git(cwd, [
    ...canonicalDiffArgs("diff"),
    "--binary",
    "--full-index",
    "--no-color",
    baseCommit,
    headCommit,
    "--",
    path,
  ]);
  if (patch === "") {
    return undefined;
  }
  return {
    diffSha256: createHash("sha256").update(patch).digest("hex"),
    parent: baseCommit,
    patch,
    patchId: git(cwd, ["patch-id", "--stable"], { input: patch }).trim().split(/\s+/)[0],
  };
}

function commitPathPatch(cwd, graph, commit, path) {
  const record = graph.get(commit);
  if (!record || record.parents.length !== 1) {
    return undefined;
  }
  return commitRangePathPatch(cwd, record.parents[0], commit, path);
}

function exactPathPatchEvidence(cwd, graph, sourceCommit, targetCommit, path) {
  const sourcePatch = commitPathPatch(cwd, graph, sourceCommit, path);
  const targetPatch = commitPathPatch(cwd, graph, targetCommit, path);
  if (
    !sourcePatch?.patchId ||
    !targetPatch?.patchId ||
    sourcePatch.patchId !== targetPatch.patchId ||
    !patchProducesPathState(cwd, sourcePatch.patch, targetPatch.parent, targetCommit, path) ||
    !patchProducesPathState(cwd, targetPatch.patch, sourcePatch.parent, sourceCommit, path)
  ) {
    return undefined;
  }
  return {
    patchId: sourcePatch.patchId,
    path,
    sourceCommit,
    sourceDiffSha256: sourcePatch.diffSha256,
    sourceParent: sourcePatch.parent,
    targetDiffSha256: targetPatch.diffSha256,
    targetParent: targetPatch.parent,
  };
}

function pathStateSha256(cwd, commit, path) {
  const state = gitBuffer(cwd, ["ls-tree", "-z", "--full-tree", commit, "--", path]);
  return createHash("sha256").update(state).digest("hex");
}

function aggregateBaseStateProof(cwd, baseCommit, headCommit, targetCommit, paths) {
  if (paths.length === 0) {
    return undefined;
  }
  const sourceExclusiveOutput = git(cwd, [
    "rev-list",
    "--full-history",
    targetCommit,
    `^${baseCommit}`,
    "--",
    ...paths,
  ]).trim();
  const sourceExclusivePathCommits = setSummary(
    sourceExclusiveOutput === "" ? [] : sourceExclusiveOutput.split("\n"),
  );
  const pathEvidence = [];
  for (const path of paths) {
    const baseStateSha256 = pathStateSha256(cwd, baseCommit, path);
    const headStateSha256 = pathStateSha256(cwd, headCommit, path);
    const targetStateSha256 = pathStateSha256(cwd, targetCommit, path);
    if (baseStateSha256 === headStateSha256 || baseStateSha256 !== targetStateSha256) {
      return undefined;
    }
    pathEvidence.push({
      baseStateSha256,
      headStateSha256,
      path,
      targetStateSha256,
    });
  }
  return {
    baseCommit,
    headCommit,
    method: "target-matches-aggregate-base-path-state",
    paths: pathEvidence,
    sourceExclusivePathCommits,
    targetCommit,
  };
}

function applyPatchToIndex(cwd, directory, environment, patch, args) {
  const patchPath = join(directory, "patch.diff");
  writeFileSync(patchPath, patch);
  const result = spawnSync(
    "git",
    ["apply", "--cached", ...args, "--binary", "--whitespace=nowarn", patchPath],
    {
      cwd,
      encoding: "utf8",
      env: environment,
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: gitApplyTimeoutMs,
    },
  );
  return !result.error && result.status === 0;
}

function patchProducesTree(cwd, patch, parent, expectedTree) {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-release-patch-"));
  const environment = canonicalGitEnvironment({ GIT_INDEX_FILE: join(directory, "index") });
  try {
    execFileSync("git", ["read-tree", parent], {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!applyPatchToIndex(cwd, directory, environment, patch, ["--3way"])) {
      return false;
    }
    return (
      execFileSync("git", ["write-tree"], {
        cwd,
        encoding: "utf8",
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim() === expectedTree
    );
  } catch {
    return false;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function patchProducesPathState(cwd, patch, parent, expectedCommit, path) {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-release-path-patch-"));
  const environment = canonicalGitEnvironment({ GIT_INDEX_FILE: join(directory, "index") });
  try {
    execFileSync("git", ["read-tree", parent], {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!applyPatchToIndex(cwd, directory, environment, patch, ["--3way"])) {
      return false;
    }
    const comparison = spawnSync(
      "git",
      ["diff", "--cached", "--quiet", "--no-ext-diff", expectedCommit, "--", path],
      {
        cwd,
        encoding: "utf8",
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return comparison.status === 0;
  } catch {
    return false;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function patchRoundTripRestoresTree(
  cwd,
  targetCommit,
  targetTree,
  patch,
  applyMode,
  { exactPatchPaths } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-release-tree-patch-"));
  const environment = canonicalGitEnvironment({ GIT_INDEX_FILE: join(directory, "index") });
  const applyPatch = (reverse) =>
    applyPatchToIndex(cwd, directory, environment, patch, [
      ...applyMode,
      ...(reverse ? ["--reverse"] : []),
    ]);
  const writeTree = () =>
    execFileSync("git", ["write-tree"], {
      cwd,
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    execFileSync("git", ["read-tree", targetCommit], {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!applyPatch(true)) {
      return false;
    }
    const reversedTree = writeTree();
    if (reversedTree === targetTree) {
      return false;
    }
    if (
      exactPatchPaths &&
      normalizedZeroContextPatch(
        zeroContextPatch(cwd, reversedTree, targetCommit, exactPatchPaths),
      ) !== normalizedZeroContextPatch(patch)
    ) {
      return false;
    }
    if (!applyPatch(false)) {
      return false;
    }
    return writeTree() === targetTree;
  } catch {
    return false;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function candidateTreeProofFields(candidate, targetCommit, targetTree) {
  return {
    candidateBaseCommit: candidate.parent,
    candidateCommit: candidate.commit,
    candidateDiffSha256: candidate.diffSha256,
    candidatePatchId: candidate.patchId,
    changedPaths: candidate.paths,
    targetCommit,
    targetTree,
  };
}

function candidatePatchTreeProof(cwd, graph, targetCommit, candidate) {
  const targetRecord = graph.get(targetCommit);
  if (
    !targetRecord ||
    candidate.paths.length === 0 ||
    !patchRoundTripRestoresTree(cwd, targetCommit, targetRecord.tree, candidate.patch, ["--3way"])
  ) {
    return undefined;
  }
  return {
    ...candidateTreeProofFields(candidate, targetCommit, targetRecord.tree),
    proofMethod: "reverse-then-forward-apply-exact-target-tree",
    proofStrength: "exact",
  };
}

function candidateExactPathTreeProof(cwd, graph, targetCommit, candidate) {
  const targetRecord = graph.get(targetCommit);
  if (!targetRecord || candidate.paths.length === 0) {
    return undefined;
  }
  const proofPatch = candidateZeroContextPatch(cwd, candidate);
  if (
    proofPatch === "" ||
    !patchRoundTripRestoresTree(
      cwd,
      targetCommit,
      targetRecord.tree,
      proofPatch,
      ["--unidiff-zero"],
      { exactPatchPaths: candidate.paths },
    )
  ) {
    return undefined;
  }
  return {
    ...candidateTreeProofFields(candidate, targetCommit, targetRecord.tree),
    proofDiffSha256: createHash("sha256").update(proofPatch).digest("hex"),
    proofMethod: "reverse-then-forward-zero-context-exact-path-tree",
    proofPatchId: git(cwd, ["patch-id", "--stable"], { input: proofPatch }).trim().split(/\s+/)[0],
    proofStrength: "exact-path",
  };
}

function candidateZeroContextPatch(cwd, candidate) {
  return zeroContextPatch(cwd, candidate.parent, candidate.commit, candidate.paths);
}

function zeroContextPatch(cwd, parent, commit, paths) {
  return git(cwd, [
    ...canonicalDiffArgs("diff", 0),
    "--binary",
    "--full-index",
    "--no-color",
    parent,
    commit,
    "--",
    ...paths,
  ]);
}

function normalizedZeroContextPatch(patch) {
  return patch
    .replace(/^index [0-9a-f]+\.\.[0-9a-f]+( [0-7]{6})?$/gm, "index <old>..<new>$1")
    .replace(/^(@@ [^@]* @@).*$/gm, "$1");
}

function parseTextPatchHunks(patch) {
  if (patch.includes("GIT binary patch") || patch.includes("Binary files ")) {
    return undefined;
  }
  const hunks = [];
  let current;
  for (const line of patch.split("\n")) {
    const header = line.match(
      /^@@ -(?<oldStart>\d+)(?:,(?<oldCount>\d+))? \+(?<newStart>\d+)(?:,(?<newCount>\d+))? @@/,
    );
    if (header?.groups) {
      current = {
        addedLineCount: 0,
        newCount: header.groups.newCount === undefined ? 1 : Number(header.groups.newCount),
        newStart: Number(header.groups.newStart),
        oldCount: header.groups.oldCount === undefined ? 1 : Number(header.groups.oldCount),
        oldStart: Number(header.groups.oldStart),
        postimageLines: [],
        preimageLines: [],
        removedLineCount: 0,
      };
      hunks.push(current);
      continue;
    }
    if (!current || line === "\\ No newline at end of file") {
      continue;
    }
    if (line.startsWith(" ")) {
      const value = line.slice(1);
      current.preimageLines.push(value);
      current.postimageLines.push(value);
    } else if (line.startsWith("-") && !line.startsWith("--- ")) {
      current.preimageLines.push(line.slice(1));
      current.removedLineCount += 1;
    } else if (line.startsWith("+") && !line.startsWith("+++ ")) {
      current.postimageLines.push(line.slice(1));
      current.addedLineCount += 1;
    }
  }
  if (
    hunks.length === 0 ||
    hunks.some(
      (hunk) =>
        hunk.preimageLines.length !== hunk.oldCount || hunk.postimageLines.length !== hunk.newCount,
    )
  ) {
    return undefined;
  }
  return hunks;
}

function readTextPathLines(cwd, commit, path) {
  const value = gitBuffer(cwd, ["show", `${commit}:${path}`]);
  if (value.includes(0)) {
    return undefined;
  }
  const text = value.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(value)) {
    return undefined;
  }
  return text.split("\n");
}

function countLineSequence(lines, sequence) {
  if (sequence.length === 0 || sequence.length > lines.length) {
    return 0;
  }
  let count = 0;
  for (let index = 0; index <= lines.length - sequence.length; index += 1) {
    if (sequence.every((line, offset) => lines[index + offset] === line)) {
      count += 1;
    }
  }
  return count;
}

function candidateHunkAnchorEvidence(
  cwd,
  graph,
  aggregateBaseCommit,
  sourceCandidate,
  targetCommit,
  path,
) {
  const targetRecord = graph.get(targetCommit);
  if (!targetRecord || targetRecord.parents.length !== 1) {
    return undefined;
  }
  const targetParent = targetRecord.parents[0];
  const aggregateBaseStateSha256 = pathStateSha256(cwd, aggregateBaseCommit, path);
  const targetParentStateSha256 = pathStateSha256(cwd, targetParent, path);
  if (aggregateBaseStateSha256 !== targetParentStateSha256) {
    return undefined;
  }
  const sourcePatch = commitRangePathPatch(
    cwd,
    sourceCandidate.parent,
    sourceCandidate.commit,
    path,
  );
  const sourceZeroContextPatch = zeroContextPatch(
    cwd,
    sourceCandidate.parent,
    sourceCandidate.commit,
    [path],
  );
  const sourceHunks = sourcePatch && parseTextPatchHunks(sourcePatch.patch);
  const sourceZeroContextHunks = parseTextPatchHunks(sourceZeroContextPatch);
  if (
    !sourceHunks ||
    !sourceZeroContextHunks ||
    sourceHunks.some((hunk) => hunk.preimageLines.length === 0 || hunk.postimageLines.length === 0)
  ) {
    return undefined;
  }
  const aggregateBaseLines = readTextPathLines(cwd, aggregateBaseCommit, path);
  const sourceParentLines = readTextPathLines(cwd, sourceCandidate.parent, path);
  const sourceCommitLines = readTextPathLines(cwd, sourceCandidate.commit, path);
  const targetParentLines = readTextPathLines(cwd, targetParent, path);
  const targetCommitLines = readTextPathLines(cwd, targetCommit, path);
  if (
    !aggregateBaseLines ||
    !sourceParentLines ||
    !sourceCommitLines ||
    !targetParentLines ||
    !targetCommitLines
  ) {
    return undefined;
  }
  const hunkRecords = sourceHunks.map((hunk) => ({
    aggregateBasePreimageOccurrences: countLineSequence(aggregateBaseLines, hunk.preimageLines),
    newCount: hunk.newCount,
    newStart: hunk.newStart,
    oldCount: hunk.oldCount,
    oldStart: hunk.oldStart,
    postimageSha256: createHash("sha256")
      .update(hunk.postimageLines.map((line) => `${line}\n`).join(""))
      .digest("hex"),
    preimageSha256: createHash("sha256")
      .update(hunk.preimageLines.map((line) => `${line}\n`).join(""))
      .digest("hex"),
    sourceCommitPostimageOccurrences: countLineSequence(sourceCommitLines, hunk.postimageLines),
    sourceParentPreimageOccurrences: countLineSequence(sourceParentLines, hunk.preimageLines),
    targetCommitPostimageOccurrences: countLineSequence(targetCommitLines, hunk.postimageLines),
    targetParentPreimageOccurrences: countLineSequence(targetParentLines, hunk.preimageLines),
  }));
  if (
    hunkRecords.some(
      (record) =>
        record.aggregateBasePreimageOccurrences !== 1 ||
        record.sourceCommitPostimageOccurrences !== 1 ||
        record.sourceParentPreimageOccurrences !== 1 ||
        record.targetCommitPostimageOccurrences !== 1 ||
        record.targetParentPreimageOccurrences !== 1,
    )
  ) {
    return undefined;
  }
  const candidateBoundary = Math.max(
    ...sourceZeroContextHunks.map((hunk) => hunk.oldStart + Math.max(hunk.oldCount - 1, 0)),
  );
  const setupPatch = zeroContextPatch(cwd, aggregateBaseCommit, sourceCandidate.parent, [path]);
  const setupHunks = setupPatch === "" ? [] : parseTextPatchHunks(setupPatch);
  if (!setupHunks || setupHunks.some((hunk) => hunk.newStart <= candidateBoundary)) {
    return undefined;
  }
  return {
    aggregateBaseCommit,
    aggregateBaseStateSha256,
    candidateBoundary,
    hunks: recordSummary(hunkRecords),
    path,
    setupHunks: recordSummary(
      setupHunks.map(({ newCount, newStart, oldCount, oldStart }) => ({
        newCount,
        newStart,
        oldCount,
        oldStart,
      })),
    ),
    sourceCommit: sourceCandidate.commit,
    sourceParent: sourceCandidate.parent,
    sourcePatchSha256: sourcePatch.diffSha256,
    targetCommit,
    targetParent,
    targetParentStateSha256,
  };
}

function changedLineHashes(patch) {
  const hashes = [];
  let diffHeader;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      diffHeader = line;
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@ ")) {
      if (!diffHeader) {
        fail("zero-context patch hunk is missing its canonical diff header");
      }
      inHunk = true;
      continue;
    }
    if (inHunk && (line.startsWith("+") || line.startsWith("-"))) {
      hashes.push(createHash("sha256").update(`${diffHeader}\n${line}\n`).digest("hex"));
    }
  }
  return [...new Set(hashes)].toSorted();
}

function candidatePatchAmbiguityProof(cwd, graph, targetCommit, candidate) {
  const targetRecord = graph.get(targetCommit);
  if (!targetRecord || candidate.paths.length === 0) {
    return undefined;
  }
  const proofPatch = candidateZeroContextPatch(cwd, candidate);
  if (
    proofPatch === "" ||
    !patchRoundTripRestoresTree(cwd, targetCommit, targetRecord.tree, proofPatch, [
      "--unidiff-zero",
    ])
  ) {
    return undefined;
  }
  return {
    ...candidateTreeProofFields(candidate, targetCommit, targetRecord.tree),
    proofDiffSha256: createHash("sha256").update(proofPatch).digest("hex"),
    proofMethod: "reverse-then-forward-zero-context-exact-target-tree",
    proofPatchId: git(cwd, ["patch-id", "--stable"], { input: proofPatch }).trim().split(/\s+/)[0],
    proofStrength: "ambiguous-target-provenance",
  };
}

function exactPatchEquivalent(cwd, graph, left, right, { inverse = false } = {}) {
  const leftPatch = commitPatch(cwd, graph, left);
  const rightPatch = commitPatch(cwd, graph, right);
  const leftRecord = graph.get(left);
  const rightRecord = graph.get(right);
  if (!leftPatch || !rightPatch || !leftRecord || !rightRecord) {
    return false;
  }
  if (inverse) {
    return (
      patchProducesTree(cwd, leftPatch.patch, right, graph.get(rightPatch.parent).tree) &&
      patchProducesTree(cwd, rightPatch.patch, left, graph.get(leftPatch.parent).tree)
    );
  }
  if (leftPatch.patchId !== rightPatch.patchId) {
    return false;
  }
  return (
    patchProducesTree(cwd, leftPatch.patch, rightPatch.parent, rightRecord.tree) &&
    patchProducesTree(cwd, rightPatch.patch, leftPatch.parent, leftRecord.tree)
  );
}

function exactCandidatePatchEquivalent(cwd, graph, target, candidate) {
  const targetPatch = commitPatch(cwd, graph, target);
  const targetRecord = graph.get(target);
  if (!targetPatch || !targetRecord) {
    return false;
  }
  if (targetPatch.patchId !== candidate.patchId) {
    return false;
  }
  return (
    patchProducesTree(cwd, candidate.patch, targetPatch.parent, targetRecord.tree) &&
    patchProducesTree(cwd, targetPatch.patch, candidate.parent, candidate.tree)
  );
}

function assertExactMapKeys(values, expectedKeys, label) {
  if (!(values instanceof Map)) {
    fail(`${label} resolver did not return a map`);
  }
  const expected = new Set(expectedKeys);
  const unexpected = [...values.keys()].filter((key) => !expected.has(key));
  if (values.size > expected.size || unexpected.length > 0) {
    fail(`${label} evidence keys do not exactly match the requested universe`);
  }
}

function normalizeAssociationMap(pullRequests, commits, label) {
  assertExactMapKeys(pullRequests, commits, `${label} association`);
  const normalized = new Map();
  for (const commit of commits) {
    if (!pullRequests.has(commit)) {
      fail(`${label} association evidence is missing commit ${commit}`);
    }
    const numbers = pullRequests.get(commit);
    if (
      !Array.isArray(numbers) ||
      numbers.some((number) => !Number.isInteger(number) || number <= 0)
    ) {
      fail(`association evidence for commit ${commit} is invalid`);
    }
    normalized.set(
      commit,
      [...new Set(numbers)].toSorted((left, right) => left - right),
    );
  }
  return normalized;
}

function normalizeAssociations(result, commits) {
  if (result instanceof Map) {
    const pullRequests = normalizeAssociationMap(result, commits, "included");
    return { allPullRequests: pullRequests, pullRequests };
  }
  const allPullRequests = normalizeAssociationMap(result?.allPullRequests, commits, "complete");
  const pullRequests = normalizeAssociationMap(result?.pullRequests, commits, "included");
  for (const commit of commits) {
    const complete = new Set(allPullRequests.get(commit));
    if (pullRequests.get(commit).some((number) => !complete.has(number))) {
      fail(`included association evidence for commit ${commit} is not a complete-evidence subset`);
    }
  }
  return { allPullRequests, pullRequests };
}

function normalizePullRequestEvidence(result, numbers) {
  assertExactMapKeys(result, numbers, "pull request");
  const normalized = new Map();
  for (const number of numbers) {
    if (!result.has(number)) {
      fail(`pull request evidence is missing #${number}`);
    }
    const node = result.get(number);
    if (node === null) {
      normalized.set(number, null);
      continue;
    }
    if (
      !node ||
      (node.__typename !== "Issue" && node.__typename !== "PullRequest") ||
      node.number !== number ||
      (node.__typename === "PullRequest" &&
        node.mergedAt !== null &&
        typeof node.mergedAt !== "string")
    ) {
      fail(`pull request evidence for #${number} is invalid`);
    }
    normalized.set(number, node);
  }
  return normalized;
}

function normalizePullRequestCommits(result, numbers) {
  assertExactMapKeys(result, numbers, "pull request commit");
  const normalized = new Map();
  for (const number of numbers) {
    if (!result.has(number)) {
      fail(`pull request commit evidence is missing #${number}`);
    }
    const commits = result.get(number);
    if (
      !Array.isArray(commits) ||
      commits.length === 0 ||
      commits.some((commit) => typeof commit !== "string" || !objectIdPattern.test(commit))
    ) {
      fail(`pull request commit evidence for #${number} is invalid`);
    }
    const unique = [...new Set(commits)];
    if (unique.length !== commits.length) {
      fail(`pull request commit evidence for #${number} contains duplicates`);
    }
    normalized.set(number, unique);
  }
  return normalized;
}

function normalizePullRequestMetadata(result, numbers) {
  assertExactMapKeys(result, numbers, "pull request metadata");
  const normalized = new Map();
  for (const number of numbers) {
    const record = result.get(number);
    const mergedAt = Date.parse(record?.mergedAt);
    if (
      record?.number !== number ||
      typeof record?.baseBranch !== "string" ||
      record.baseBranch.length === 0 ||
      typeof record?.baseCommit !== "string" ||
      !objectIdPattern.test(record.baseCommit) ||
      typeof record?.headCommit !== "string" ||
      !objectIdPattern.test(record.headCommit) ||
      typeof record?.mergeCommit !== "string" ||
      !objectIdPattern.test(record.mergeCommit) ||
      !Number.isFinite(mergedAt)
    ) {
      fail(`pull request metadata evidence for #${number} is invalid`);
    }
    normalized.set(number, {
      baseBranch: record.baseBranch,
      baseCommit: record.baseCommit,
      headCommit: record.headCommit,
      mergeCommit: record.mergeCommit,
      mergedAt: new Date(mergedAt).toISOString(),
      number,
    });
  }
  return normalized;
}

function activeCommitsAfterReverts(commits, edges) {
  const members = new Set(commits);
  const revertsByTarget = new Map();
  for (const edge of edges) {
    if (!members.has(edge.revertCommit) || !members.has(edge.targetCommit)) {
      continue;
    }
    const reverts = revertsByTarget.get(edge.targetCommit) ?? [];
    reverts.push(edge.revertCommit);
    revertsByTarget.set(edge.targetCommit, reverts);
  }
  const active = new Map();
  function isActive(commit, seen = new Set()) {
    if (active.has(commit)) {
      return active.get(commit);
    }
    if (seen.has(commit)) {
      fail(`cyclic revert graph at ${commit}`);
    }
    const nextSeen = new Set(seen);
    nextSeen.add(commit);
    const value = !(revertsByTarget.get(commit) ?? []).some((revert) => isActive(revert, nextSeen));
    active.set(commit, value);
    return value;
  }
  return new Set([...members].filter((commit) => isActive(commit)));
}

function revertLineage(graph, start) {
  const commits = [];
  const seen = new Set();
  let current = start;
  while (graph.has(current)) {
    if (seen.has(current)) {
      fail(`cyclic revert lineage at ${current}`);
    }
    seen.add(current);
    commits.push(current);
    const [target] = revertedCommits(graph.get(current).message);
    if (!target) {
      break;
    }
    current = target;
  }
  return commits;
}

function setSummary(values, compare = (left, right) => String(left).localeCompare(String(right))) {
  const members = [...new Set(values)].sort(compare);
  return {
    count: members.length,
    members,
    sha256: createHash("sha256")
      .update(members.map((value) => `${value}\n`).join(""))
      .digest("hex"),
  };
}

function recordSummary(values) {
  const serialized = values.map((value) => JSON.stringify(value));
  if (new Set(serialized).size !== serialized.length) {
    fail("release source inventory evidence records contain duplicates");
  }
  const sorted = serialized.toSorted();
  return {
    count: sorted.length,
    records: sorted.map((value) => JSON.parse(value)),
    sha256: createHash("sha256")
      .update(sorted.map((value) => `${value}\n`).join(""))
      .digest("hex"),
  };
}

function orderedRecordSummary(values, compare) {
  const records = [...values].sort(compare);
  const serialized = records.map((value) => JSON.stringify(value));
  if (new Set(serialized).size !== serialized.length) {
    fail("release source inventory evidence records contain duplicates");
  }
  return {
    count: records.length,
    records,
    sha256: createHash("sha256")
      .update(serialized.map((value) => `${value}\n`).join(""))
      .digest("hex"),
  };
}

function digestInventory(inventory) {
  return createHash("sha256")
    .update(`${JSON.stringify(inventory)}\n`)
    .digest("hex");
}

function changedPaths(cwd, parent, commit) {
  return git(cwd, [...canonicalDiffArgs("diff"), "--name-only", "-z", parent, commit, "--"])
    .split("\0")
    .filter(Boolean)
    .toSorted();
}

function sourceTailCommits(graph, sourceTarget, finalTarget, maxCommits) {
  if (!Number.isSafeInteger(maxCommits) || maxCommits < 0 || maxCommits > graph.size) {
    fail("maximum CHANGELOG-only tail length is invalid");
  }
  const reversed = [];
  let current = finalTarget;
  while (current !== sourceTarget) {
    const record = graph.get(current);
    if (!record || record.parents.length !== 1) {
      fail(
        `final target ${finalTarget} is not a linear descendant of source target ${sourceTarget}`,
      );
    }
    reversed.push(current);
    if (reversed.length > maxCommits) {
      fail(
        `final target ${finalTarget} exceeds the allowed ${maxCommits}-commit CHANGELOG-only tail from ${sourceTarget}`,
      );
    }
    current = record.parents[0];
  }
  return reversed.reverse();
}

function normalizeComparisonUniverse(
  result,
  { baseBranch, endTimestamp, repository, startTimestamp },
) {
  const query = teamUniverseWindowQuery({
    base: baseBranch,
    end: isoSecond(endTimestamp),
    repository,
    start: isoSecond(startTimestamp),
  });
  if (
    !result ||
    result.baseBranch !== baseBranch ||
    result.query !== query ||
    result.repository !== repository ||
    result.window?.startTimestamp !== startTimestamp ||
    result.window?.endTimestamp !== endTimestamp ||
    !Number.isInteger(result.count) ||
    result.count < 0 ||
    !Array.isArray(result.pullRequests) ||
    result.pullRequests.some((number) => !Number.isInteger(number) || number <= 0) ||
    !Array.isArray(result.records) ||
    typeof result.recordsSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(result.recordsSha256) ||
    typeof result.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(result.sha256) ||
    !Array.isArray(result.segments)
  ) {
    fail("merged pull request comparison resolver returned invalid evidence");
  }
  const pullRequests = summarizeTeamUniverseMembers(result.pullRequests);
  if (
    pullRequests.count !== result.count ||
    pullRequests.count !== result.pullRequests.length ||
    pullRequests.sha256 !== result.sha256 ||
    JSON.stringify(pullRequests.members) !== JSON.stringify(result.pullRequests)
  ) {
    fail("merged pull request comparison resolver returned inconsistent members");
  }
  const records = result.records.map((record) => {
    const mergedAt = Date.parse(record?.mergedAt);
    if (
      record?.baseBranch !== baseBranch ||
      typeof record?.baseCommit !== "string" ||
      !objectIdPattern.test(record.baseCommit) ||
      typeof record?.headCommit !== "string" ||
      !objectIdPattern.test(record.headCommit) ||
      typeof record?.mergeCommit !== "string" ||
      !objectIdPattern.test(record.mergeCommit) ||
      !Number.isFinite(mergedAt) ||
      mergedAt < startTimestamp ||
      mergedAt > endTimestamp ||
      !Number.isInteger(record?.number) ||
      record.number <= 0
    ) {
      fail("merged pull request comparison resolver returned invalid PR metadata");
    }
    return {
      baseBranch,
      baseCommit: record.baseCommit,
      headCommit: record.headCommit,
      mergeCommit: record.mergeCommit,
      mergedAt: new Date(mergedAt).toISOString(),
      number: record.number,
    };
  });
  const recordSummary = summarizeTeamUniverseRecords(records);
  if (
    recordSummary.count !== result.count ||
    recordSummary.sha256 !== result.recordsSha256 ||
    JSON.stringify(recordSummary.records) !== JSON.stringify(result.records) ||
    JSON.stringify(recordSummary.records.map((record) => record.number)) !==
      JSON.stringify(pullRequests.members)
  ) {
    fail("merged pull request comparison resolver returned inconsistent PR metadata");
  }
  if (result.segments.length === 0) {
    fail("merged pull request comparison resolver returned no search segments");
  }
  const recordByNumber = new Map(records.map((record) => [record.number, record]));
  const segments = result.segments.map((segment, index) => {
    const segmentStart = segment?.window?.startTimestamp;
    const segmentEnd = segment?.window?.endTimestamp;
    if (
      !Number.isSafeInteger(segmentStart) ||
      !Number.isSafeInteger(segmentEnd) ||
      segmentStart < startTimestamp ||
      segmentEnd > endTimestamp ||
      segmentStart > segmentEnd ||
      segment?.query !==
        teamUniverseWindowQuery({
          base: baseBranch,
          end: isoSecond(segmentEnd),
          repository,
          start: isoSecond(segmentStart),
        }) ||
      !Number.isInteger(segment?.count) ||
      segment.count < 0 ||
      !Array.isArray(segment?.pullRequests) ||
      typeof segment?.recordsSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(segment.recordsSha256) ||
      typeof segment?.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(segment.sha256)
    ) {
      fail(`merged pull request comparison resolver returned invalid segment ${index}`);
    }
    const members = summarizeTeamUniverseMembers(segment.pullRequests);
    const segmentRecords = segment.pullRequests.map((number) => {
      const record = recordByNumber.get(number);
      const mergedAt = Date.parse(record?.mergedAt);
      if (!record || mergedAt < segmentStart || mergedAt > segmentEnd) {
        fail(`merged pull request comparison segment ${index} contains invalid member #${number}`);
      }
      return record;
    });
    const segmentRecordSummary = summarizeTeamUniverseRecords(segmentRecords);
    if (
      members.count !== segment.count ||
      members.count !== segment.pullRequests.length ||
      members.sha256 !== segment.sha256 ||
      segmentRecordSummary.sha256 !== segment.recordsSha256 ||
      JSON.stringify(members.members) !== JSON.stringify(segment.pullRequests)
    ) {
      fail(`merged pull request comparison segment ${index} is inconsistent`);
    }
    return {
      count: members.count,
      pullRequests: members.members,
      query: segment.query,
      recordsSha256: segmentRecordSummary.sha256,
      sha256: members.sha256,
      window: { endTimestamp: segmentEnd, startTimestamp: segmentStart },
    };
  });
  if (
    segments[0].window.startTimestamp !== startTimestamp ||
    segments.at(-1).window.endTimestamp !== endTimestamp ||
    segments.some(
      (segment, index) =>
        index > 0 && segments[index - 1].window.endTimestamp !== segment.window.startTimestamp,
    )
  ) {
    fail("merged pull request comparison segments do not exactly cover the requested window");
  }
  const segmentMembers = summarizeTeamUniverseMembers(
    segments.flatMap((segment) => segment.pullRequests),
  );
  if (
    segmentMembers.count !== pullRequests.count ||
    segmentMembers.sha256 !== pullRequests.sha256
  ) {
    fail("merged pull request comparison segments do not equal the requested universe");
  }
  return {
    baseBranch,
    pullRequests: pullRequests.members,
    query,
    records,
    recordsSha256: recordSummary.sha256,
    repository,
    segments,
    sha256: pullRequests.sha256,
    window: { endTimestamp, startTimestamp },
  };
}

function mergeResolutionDigest(cwd, commit) {
  const diff = git(cwd, [
    ...canonicalDiffArgs("show"),
    "--remerge-diff",
    "--format=",
    "--binary",
    "--full-index",
    "--no-color",
    commit,
    "--",
  ]);
  return diff === "" ? undefined : createHash("sha256").update(diff).digest("hex");
}

export function buildReleaseSourceInventory(
  {
    baseRef,
    comparisonBaseBranch,
    cwd = process.cwd(),
    finalTargetRef,
    maxSourceTailCommits = 1,
    provenanceAdaptedPullRequests = [],
    comparisonPullRequestMemberOverlaps = [],
    provenanceIntegratedPullRequests = [],
    provenancePartialPullRequests = [],
    provenanceRefs = [],
    provenancePullRequests = [],
    repository = "openclaw/openclaw",
    shippedRefs = [],
    sourceTargetRef,
  },
  {
    resolveAssociations,
    resolveComparisonPullRequests,
    resolvePullRequestCommits,
    resolvePullRequestMetadata,
    resolvePullRequests,
  },
) {
  assertCanonicalRepository(cwd);
  const base = resolveCommit(cwd, baseRef);
  const sourceTarget = resolveCommit(cwd, sourceTargetRef);
  const finalTarget = resolveCommit(cwd, finalTargetRef ?? sourceTargetRef);
  const shipped = shippedRefs.map((ref) => ({ commit: resolveCommit(cwd, ref), ref }));
  const provenance = provenanceRefs.map((ref) => ({ commit: resolveCommit(cwd, ref), ref }));
  const trustedComparisonPullRequestMemberOverlaps = comparisonPullRequestMemberOverlaps
    .map(({ number, sourceCommitRef, targetCommitRef, witnessCommitRef }) => {
      if (
        !Number.isInteger(number) ||
        number <= 0 ||
        typeof sourceCommitRef !== "string" ||
        typeof targetCommitRef !== "string" ||
        typeof witnessCommitRef !== "string"
      ) {
        fail("trusted comparison pull request member overlap is invalid");
      }
      return {
        number,
        sourceCommit: resolveCommit(cwd, sourceCommitRef),
        sourceRef: sourceCommitRef,
        targetCommit: resolveCommit(cwd, targetCommitRef),
        targetRef: targetCommitRef,
        witnessCommit: resolveCommit(cwd, witnessCommitRef),
        witnessRef: witnessCommitRef,
      };
    })
    .toSorted(
      (left, right) =>
        left.number - right.number ||
        left.sourceCommit.localeCompare(right.sourceCommit) ||
        left.targetCommit.localeCompare(right.targetCommit) ||
        left.witnessCommit.localeCompare(right.witnessCommit),
    );
  const trustedComparisonPullRequestMemberOverlapKeys = new Set(
    trustedComparisonPullRequestMemberOverlaps.map(
      (entry) =>
        `${entry.number}:${entry.sourceCommit}:${entry.targetCommit}:${entry.witnessCommit}`,
    ),
  );
  if (
    trustedComparisonPullRequestMemberOverlapKeys.size !==
    trustedComparisonPullRequestMemberOverlaps.length
  ) {
    fail("trusted comparison pull request member overlap values must be unique");
  }
  if (
    new Set(trustedComparisonPullRequestMemberOverlaps.map((entry) => entry.number)).size !==
    trustedComparisonPullRequestMemberOverlaps.length
  ) {
    fail("trusted comparison pull request member overlap numbers must be unique");
  }
  if (
    new Set(trustedComparisonPullRequestMemberOverlaps.map((entry) => entry.sourceCommit)).size !==
    trustedComparisonPullRequestMemberOverlaps.length
  ) {
    fail("trusted comparison pull request member overlap source commits must be unique");
  }
  if (
    new Set(trustedComparisonPullRequestMemberOverlaps.map((entry) => entry.targetCommit)).size !==
    trustedComparisonPullRequestMemberOverlaps.length
  ) {
    fail("trusted comparison pull request member overlap target commits must be unique");
  }
  if (
    new Set(trustedComparisonPullRequestMemberOverlaps.map((entry) => entry.witnessCommit)).size !==
    trustedComparisonPullRequestMemberOverlaps.length
  ) {
    fail("trusted comparison pull request member overlap witness commits must be unique");
  }
  if (
    trustedComparisonPullRequestMemberOverlaps.some(
      (entry) =>
        entry.sourceCommit === entry.targetCommit ||
        entry.sourceCommit === entry.witnessCommit ||
        entry.targetCommit === entry.witnessCommit,
    )
  ) {
    fail("trusted comparison pull request member overlap commits must be distinct");
  }
  const trustedComparisonPullRequestMemberOverlapCommits =
    trustedComparisonPullRequestMemberOverlaps.flatMap((entry) => [
      entry.sourceCommit,
      entry.targetCommit,
      entry.witnessCommit,
    ]);
  if (
    new Set(trustedComparisonPullRequestMemberOverlapCommits).size !==
    trustedComparisonPullRequestMemberOverlaps.length * 3
  ) {
    fail("trusted comparison pull request member overlap commit roles must be disjoint");
  }
  if (trustedComparisonPullRequestMemberOverlaps.length > 0 && !comparisonBaseBranch) {
    fail("trusted comparison pull request member overlap requires comparison evidence");
  }
  const trustedAdaptedPullRequestProvenance = provenanceAdaptedPullRequests.map(
    ({ number, originCommitRef, targetCommitRef }) => {
      if (
        !Number.isInteger(number) ||
        number <= 0 ||
        typeof originCommitRef !== "string" ||
        typeof targetCommitRef !== "string"
      ) {
        fail("trusted adapted pull request provenance is invalid");
      }
      return {
        number,
        originCommit: resolveCommit(cwd, originCommitRef),
        originRef: originCommitRef,
        targetCommit: resolveCommit(cwd, targetCommitRef),
        targetRef: targetCommitRef,
      };
    },
  );
  const trustedAdaptedPullRequestProvenanceKeys = new Set(
    trustedAdaptedPullRequestProvenance.map(
      (entry) => `${entry.number}:${entry.originCommit}:${entry.targetCommit}`,
    ),
  );
  if (trustedAdaptedPullRequestProvenanceKeys.size !== trustedAdaptedPullRequestProvenance.length) {
    fail("trusted adapted pull request provenance values must be unique");
  }
  if (
    new Set(trustedAdaptedPullRequestProvenance.map((entry) => entry.targetCommit)).size !==
    trustedAdaptedPullRequestProvenance.length
  ) {
    fail("trusted adapted pull request provenance target commits must be unique");
  }
  const trustedIntegratedPullRequestEntries = provenanceIntegratedPullRequests.map(
    ({ number, sourceCommitRef, targetCommitRef }) => {
      if (
        !Number.isInteger(number) ||
        number <= 0 ||
        typeof sourceCommitRef !== "string" ||
        typeof targetCommitRef !== "string"
      ) {
        fail("trusted integrated pull request provenance is invalid");
      }
      return {
        number,
        sourceCommit: resolveCommit(cwd, sourceCommitRef),
        sourceRef: sourceCommitRef,
        targetCommit: resolveCommit(cwd, targetCommitRef),
        targetRef: targetCommitRef,
      };
    },
  );
  const trustedIntegratedPullRequestEntryKeys = new Set(
    trustedIntegratedPullRequestEntries.map(
      (entry) => `${entry.number}:${entry.sourceCommit}:${entry.targetCommit}`,
    ),
  );
  if (trustedIntegratedPullRequestEntryKeys.size !== trustedIntegratedPullRequestEntries.length) {
    fail("trusted integrated pull request provenance values must be unique");
  }
  const trustedIntegratedPullRequestGroups = new Map();
  for (const entry of trustedIntegratedPullRequestEntries) {
    const current = trustedIntegratedPullRequestGroups.get(entry.targetCommit);
    if (current && current.number !== entry.number) {
      fail(
        "trusted integrated pull request provenance target commits must map to one pull request",
      );
    }
    const group = current ?? {
      number: entry.number,
      sources: [],
      targetCommit: entry.targetCommit,
      targetRef: entry.targetRef,
    };
    group.sources.push({ commit: entry.sourceCommit, ref: entry.sourceRef });
    trustedIntegratedPullRequestGroups.set(entry.targetCommit, group);
  }
  const trustedIntegratedPullRequestProvenance = [...trustedIntegratedPullRequestGroups.values()]
    .map((entry) => ({
      ...entry,
      sources: entry.sources.toSorted((left, right) => left.commit.localeCompare(right.commit)),
    }))
    .toSorted(
      (left, right) =>
        left.number - right.number || left.targetCommit.localeCompare(right.targetCommit),
    );
  for (const entry of trustedIntegratedPullRequestProvenance) {
    if (entry.sources.length < 2) {
      fail(
        `trusted integrated provenance #${entry.number}:${entry.targetCommit} must bind at least two unique pull request source commits`,
      );
    }
  }
  const trustedPartialPullRequestProvenance = provenancePartialPullRequests.map(
    ({ number, sourceCommitRef, targetCommitRef }) => {
      if (
        !Number.isInteger(number) ||
        number <= 0 ||
        typeof sourceCommitRef !== "string" ||
        typeof targetCommitRef !== "string"
      ) {
        fail("trusted partial pull request provenance is invalid");
      }
      return {
        number,
        sourceCommit: resolveCommit(cwd, sourceCommitRef),
        sourceRef: sourceCommitRef,
        targetCommit: resolveCommit(cwd, targetCommitRef),
        targetRef: targetCommitRef,
      };
    },
  );
  const trustedPartialPullRequestProvenanceKeys = new Set(
    trustedPartialPullRequestProvenance.map(
      (entry) => `${entry.number}:${entry.sourceCommit}:${entry.targetCommit}`,
    ),
  );
  if (trustedPartialPullRequestProvenanceKeys.size !== trustedPartialPullRequestProvenance.length) {
    fail("trusted partial pull request provenance values must be unique");
  }
  if (
    new Set(trustedPartialPullRequestProvenance.map((entry) => entry.targetCommit)).size !==
    trustedPartialPullRequestProvenance.length
  ) {
    fail("trusted partial pull request provenance target commits must be unique");
  }
  const explicitProvenanceTargets = [
    ...trustedAdaptedPullRequestProvenance.map((entry) => entry.targetCommit),
    ...trustedIntegratedPullRequestProvenance.map((entry) => entry.targetCommit),
    ...trustedPartialPullRequestProvenance.map((entry) => entry.targetCommit),
  ];
  if (new Set(explicitProvenanceTargets).size !== explicitProvenanceTargets.length) {
    fail("trusted adapted, integrated, and partial provenance target commits must be disjoint");
  }
  if (
    trustedComparisonPullRequestMemberOverlaps.some((entry) =>
      [entry.sourceCommit, entry.targetCommit, entry.witnessCommit].some((commit) =>
        explicitProvenanceTargets.includes(commit),
      ),
    )
  ) {
    fail("trusted comparison overlap commits and provenance target commits must be disjoint");
  }
  const trustedPullRequestProvenance = provenancePullRequests.map(({ commitRef, number }) => {
    if (!Number.isInteger(number) || number <= 0 || typeof commitRef !== "string") {
      fail("trusted pull request provenance is invalid");
    }
    return { commit: resolveCommit(cwd, commitRef), number, ref: commitRef };
  });
  const trustedPullRequestProvenanceKeys = new Set(
    trustedPullRequestProvenance.map((entry) => `${entry.number}:${entry.commit}`),
  );
  if (trustedPullRequestProvenanceKeys.size !== trustedPullRequestProvenance.length) {
    fail("trusted pull request provenance values must be unique");
  }
  const ownershipPullRequestNumberSet = new Set([
    ...trustedAdaptedPullRequestProvenance.map((entry) => entry.number),
    ...trustedIntegratedPullRequestProvenance.map((entry) => entry.number),
    ...trustedPartialPullRequestProvenance.map((entry) => entry.number),
    ...trustedPullRequestProvenance.map((entry) => entry.number),
  ]);
  const ownershipPullRequestNumbers = [...ownershipPullRequestNumberSet].toSorted(
    (left, right) => left - right,
  );
  if (
    trustedComparisonPullRequestMemberOverlaps.some((entry) =>
      ownershipPullRequestNumberSet.has(entry.number),
    )
  ) {
    fail("trusted comparison overlap and provenance pull request numbers must be disjoint");
  }
  const ownershipProvenanceCommits = new Set([
    ...trustedAdaptedPullRequestProvenance.flatMap((entry) => [
      entry.originCommit,
      entry.targetCommit,
    ]),
    ...trustedIntegratedPullRequestProvenance.flatMap((entry) => [
      ...entry.sources.map((source) => source.commit),
      entry.targetCommit,
    ]),
    ...trustedPartialPullRequestProvenance.flatMap((entry) => [
      entry.sourceCommit,
      entry.targetCommit,
    ]),
    ...trustedPullRequestProvenance.map((entry) => entry.commit),
  ]);
  if (
    trustedComparisonPullRequestMemberOverlapCommits.some((commit) =>
      ownershipProvenanceCommits.has(commit),
    )
  ) {
    fail("trusted comparison overlap commits and provenance commits must be disjoint");
  }
  const pullRequestCommitNumbers = [
    ...new Set([
      ...trustedComparisonPullRequestMemberOverlaps.map((entry) => entry.number),
      ...trustedAdaptedPullRequestProvenance.map((entry) => entry.number),
      ...trustedIntegratedPullRequestProvenance.map((entry) => entry.number),
      ...trustedPartialPullRequestProvenance.map((entry) => entry.number),
      ...trustedPullRequestProvenance.map((entry) => entry.number),
    ]),
  ].toSorted((left, right) => left - right);
  if (pullRequestCommitNumbers.length > 0 && typeof resolvePullRequestCommits !== "function") {
    fail("release source inventory requires a pull request commit resolver");
  }
  const provenancePullRequestCommits =
    pullRequestCommitNumbers.length === 0
      ? new Map()
      : normalizePullRequestCommits(
          resolvePullRequestCommits(pullRequestCommitNumbers),
          pullRequestCommitNumbers,
        );
  if (ownershipPullRequestNumbers.length > 0 && typeof resolvePullRequestMetadata !== "function") {
    fail("release source inventory requires a pull request metadata resolver");
  }
  const ownershipPullRequestMetadata =
    ownershipPullRequestNumbers.length === 0
      ? new Map()
      : normalizePullRequestMetadata(
          resolvePullRequestMetadata(ownershipPullRequestNumbers),
          ownershipPullRequestNumbers,
        );
  const graph = readRawClosure(cwd, [
    base,
    sourceTarget,
    finalTarget,
    ...shipped.map((entry) => entry.commit),
    ...provenance.map((entry) => entry.commit),
    ...trustedComparisonPullRequestMemberOverlaps.flatMap((entry) => [
      entry.sourceCommit,
      entry.targetCommit,
      entry.witnessCommit,
    ]),
    ...trustedAdaptedPullRequestProvenance.flatMap((entry) => [
      entry.originCommit,
      entry.targetCommit,
    ]),
    ...trustedIntegratedPullRequestProvenance.flatMap((entry) => [
      ...entry.sources.map((source) => source.commit),
      entry.targetCommit,
    ]),
    ...trustedPartialPullRequestProvenance.flatMap((entry) => [
      entry.sourceCommit,
      entry.targetCommit,
    ]),
    ...trustedPullRequestProvenance.map((entry) => entry.commit),
    ...[...provenancePullRequestCommits.values()].flatMap((commits) => commits),
  ]);
  const trustedAdaptedPullRequestMemberMatches = new Map(
    trustedAdaptedPullRequestProvenance.map((entry) => [
      entry.targetCommit,
      provenancePullRequestCommits
        .get(entry.number)
        .filter((commit) => exactPatchEquivalent(cwd, graph, entry.originCommit, commit)),
    ]),
  );
  const adaptedAggregatePullRequestNumbers = [
    ...new Set(
      trustedAdaptedPullRequestProvenance
        .filter(
          (entry) => trustedAdaptedPullRequestMemberMatches.get(entry.targetCommit).length === 0,
        )
        .map((entry) => entry.number),
    ),
  ].toSorted((left, right) => left - right);
  const adaptedAggregatePullRequestMetadata =
    adaptedAggregatePullRequestNumbers.length === 0
      ? new Map()
      : new Map(
          adaptedAggregatePullRequestNumbers.map((number) => [
            number,
            ownershipPullRequestMetadata.get(number),
          ]),
        );
  extendGraphWithCommitsAndParents(
    cwd,
    graph,
    [...adaptedAggregatePullRequestMetadata.values()].flatMap((entry) => [
      entry.baseCommit,
      entry.headCommit,
      entry.mergeCommit,
    ]),
  );
  const mergeBase = rawMergeBase(graph, base, sourceTarget);
  const boundaryAncestors = ancestorsOf(graph, mergeBase);
  const sourceAncestors = ancestorsOf(graph, sourceTarget);
  const sourceCommits = oldestFirst(
    graph,
    [...sourceAncestors].filter((commit) => !boundaryAncestors.has(commit)),
  );
  const targetTimestamp = graph.get(sourceTarget).committer.timestamp;
  const finalTargetTimestamp = graph.get(finalTarget).committer.timestamp;
  const tailCommits = sourceTailCommits(graph, sourceTarget, finalTarget, maxSourceTailCommits);
  let comparisonUniverse;
  if (comparisonBaseBranch) {
    if (typeof resolveComparisonPullRequests !== "function") {
      fail("release source inventory requires a merged pull request comparison resolver");
    }
    const startTimestamp = graph.get(mergeBase).committer.timestamp;
    comparisonUniverse = normalizeComparisonUniverse(
      resolveComparisonPullRequests({
        baseBranch: comparisonBaseBranch,
        endTimestamp: targetTimestamp,
        repository,
        startTimestamp,
      }),
      {
        baseBranch: comparisonBaseBranch,
        endTimestamp: targetTimestamp,
        repository,
        startTimestamp,
      },
    );
  }
  const sourceOrigins = [
    ...new Set(sourceCommits.flatMap((commit) => cherryPickOrigins(graph.get(commit).body))),
  ];
  if (sourceOrigins.length > 0) {
    const originGraph = readRawClosure(cwd, sourceOrigins);
    for (const [commit, record] of originGraph) {
      graph.set(commit, record);
    }
  }
  const provenanceExclusive = [
    ...new Set(
      provenance.flatMap((entry) =>
        [...ancestorsOf(graph, entry.commit)].filter((commit) => !sourceAncestors.has(commit)),
      ),
    ),
  ];
  const provenanceCandidates = provenanceExclusive.filter((commit) => {
    const record = graph.get(commit);
    return record.parents.length === 1 && record.committer.timestamp <= targetTimestamp;
  });
  const externalRevertLineage = [
    ...new Set(
      sourceCommits.flatMap((commit) => {
        return revertedCommits(graph.get(commit).message).flatMap((target) =>
          revertLineage(graph, target),
        );
      }),
    ),
  ];
  const shippedHistoryByRef = shipped.map((entry) => ({
    ...entry,
    commits: [...ancestorsOf(graph, entry.commit)].filter(
      (commit) => !boundaryAncestors.has(commit),
    ),
    mergeBase: rawMergeBase(graph, entry.commit, sourceTarget),
  }));
  const associationCommits = [
    ...new Set([
      ...sourceCommits,
      ...sourceOrigins,
      ...provenanceCandidates,
      ...externalRevertLineage,
      ...shippedHistoryByRef.flatMap((entry) => entry.commits),
      ...tailCommits,
      ...trustedComparisonPullRequestMemberOverlaps.flatMap((entry) => [
        entry.sourceCommit,
        entry.witnessCommit,
      ]),
      ...trustedAdaptedPullRequestProvenance.map((entry) => entry.originCommit),
      ...trustedIntegratedPullRequestProvenance.flatMap((entry) =>
        entry.sources.map((source) => source.commit),
      ),
      ...trustedPartialPullRequestProvenance.map((entry) => entry.sourceCommit),
      ...(comparisonUniverse ? [mergeBase] : []),
    ]),
  ].toSorted();
  const associationEvidence = normalizeAssociations(
    resolveAssociations(associationCommits, graph.get(sourceTarget).committer.timestamp),
    associationCommits,
  );
  const associations = associationEvidence.pullRequests;
  const allAssociations = associationEvidence.allPullRequests;
  const associationSnapshots = orderedRecordSummary(
    associationCommits.map((commit) => ({
      commit,
      pullRequests: associations.get(commit),
      allPullRequests: allAssociations.get(commit),
    })),
    (left, right) => left.commit.localeCompare(right.commit),
  );
  const sourceCommitSet = new Set(sourceCommits);
  const comparisonMergeCommitOwners = new Map();
  for (const record of comparisonUniverse?.records ?? []) {
    if (!sourceCommitSet.has(record.mergeCommit)) {
      continue;
    }
    if (Date.parse(record.mergedAt) > targetTimestamp + 1_000) {
      fail(
        `comparison merge commit ${record.mergeCommit} maps to pull request #${record.number} merged after the source target cutoff`,
      );
    }
    const existing = comparisonMergeCommitOwners.get(record.mergeCommit);
    if (existing !== undefined && existing !== record.number) {
      fail(`comparison merge commit ${record.mergeCommit} maps to more than one pull request`);
    }
    comparisonMergeCommitOwners.set(record.mergeCommit, record.number);
  }
  const canonicalAssociationsFor = (commit) => {
    const owner = comparisonMergeCommitOwners.get(commit);
    const pullRequests = associations.get(commit) ?? [];
    return owner === undefined
      ? pullRequests
      : [...new Set([...pullRequests, owner])].toSorted((left, right) => left - right);
  };

  let sourceTail;
  if (tailCommits.length > 0) {
    const commits = tailCommits.map((commit, index) => {
      const record = graph.get(commit);
      const parent = index === 0 ? sourceTarget : tailCommits[index - 1];
      const paths = changedPaths(cwd, parent, commit);
      const explicit = explicitPullRequestReferences(record.subject, record.body);
      const origins = [...cherryPickOrigins(record.body), ...adaptationOrigins(record.body)];
      if (
        record.parents.length !== 1 ||
        record.parents[0] !== parent ||
        paths.length !== 1 ||
        paths[0] !== "CHANGELOG.md" ||
        allAssociations.get(commit).length > 0 ||
        explicit.length > 0 ||
        origins.length > 0 ||
        localReferencesIn(record.message).length > 0
      ) {
        fail(
          `final target ${finalTarget} must be a linear association-free, reference-free CHANGELOG.md-only tail from ${sourceTarget}`,
        );
      }
      return {
        commit,
        diffSha256: commitPatch(cwd, graph, commit)?.diffSha256,
        parent,
        paths,
        subject: record.subject,
        tree: record.tree,
      };
    });
    sourceTail = {
      commits,
      count: commits.length,
      maxCommits: maxSourceTailCommits,
      sha256: createHash("sha256")
        .update(`${JSON.stringify(commits)}\n`)
        .digest("hex"),
    };
  }

  const sourceRecords = sourceCommits.map((commit, topoIndex) => {
    const record = graph.get(commit);
    return {
      ...record,
      adaptationOrigins: adaptationOrigins(record.body),
      associatedPullRequests: canonicalAssociationsFor(commit),
      cherryPickOrigins: cherryPickOrigins(record.body),
      explicitPullRequestReferences: explicitPullRequestReferences(record.subject, record.body),
      nonEquivalentCherryPickOrigins: [],
      references: localReferencesIn(record.message),
      revertEvidence: [],
      revertedExternalPullRequests: [],
      revertedExternalReferences: [],
      topoIndex,
      verifiedCherryPickOrigins: [],
    };
  });
  const explicitNumbers = [
    ...new Set([
      ...sourceRecords.flatMap((record) => record.explicitPullRequestReferences),
      ...trustedAdaptedPullRequestProvenance.map((entry) => entry.number),
      ...trustedIntegratedPullRequestProvenance.map((entry) => entry.number),
      ...trustedPartialPullRequestProvenance.map((entry) => entry.number),
      ...trustedPullRequestProvenance.map((entry) => entry.number),
    ]),
  ].toSorted((left, right) => left - right);
  if (explicitNumbers.length > 0 && typeof resolvePullRequests !== "function") {
    fail("release source inventory requires a pull request evidence resolver");
  }
  const explicitPullRequests =
    explicitNumbers.length === 0
      ? new Map()
      : normalizePullRequestEvidence(resolvePullRequests(explicitNumbers), explicitNumbers);
  const referenceSnapshots = orderedRecordSummary(
    explicitNumbers.map((number) => {
      const node = explicitPullRequests.get(number);
      if (!node) {
        fail(`reference snapshot evidence for #${number} is unresolved`);
      }
      let mergedAt = null;
      if (node.__typename === "PullRequest" && node.mergedAt !== null) {
        const timestamp = Date.parse(node.mergedAt);
        if (!Number.isFinite(timestamp)) {
          fail(`reference snapshot evidence for #${number} has an invalid merge timestamp`);
        }
        mergedAt = new Date(timestamp).toISOString();
      }
      return { number, type: node.__typename, mergedAt };
    }),
    (left, right) => left.number - right.number,
  );
  const pullRequestSnapshots = orderedRecordSummary(
    ownershipPullRequestNumbers.map((number) => {
      const metadata = ownershipPullRequestMetadata.get(number);
      const commits = provenancePullRequestCommits.get(number);
      const node = explicitPullRequests.get(number);
      const nodeMergedTimestamp =
        node?.__typename === "PullRequest" && typeof node.mergedAt === "string"
          ? Date.parse(node.mergedAt)
          : Number.NaN;
      const mergedAt = Number.isFinite(nodeMergedTimestamp)
        ? new Date(nodeMergedTimestamp).toISOString()
        : undefined;
      if (
        !metadata ||
        !commits ||
        mergedAt !== metadata.mergedAt ||
        !commits.includes(metadata.headCommit)
      ) {
        fail(`pull request snapshot evidence for #${number} is inconsistent`);
      }
      return {
        number,
        baseBranch: metadata.baseBranch,
        baseCommit: metadata.baseCommit,
        headCommit: metadata.headCommit,
        mergeCommit: metadata.mergeCommit,
        mergedAt: metadata.mergedAt,
        commits: commits.toSorted(),
      };
    }),
    (left, right) => left.number - right.number,
  );
  const patchCache = new Map();
  const patchFor = (commit) => {
    if (!patchCache.has(commit)) {
      patchCache.set(commit, commitPatch(cwd, graph, commit));
    }
    return patchCache.get(commit);
  };
  const trustedPullRequestEvidence = new Map();
  const trustedPullRequestDetails = new Map();
  for (const provenanceEntry of trustedPullRequestProvenance) {
    const node = explicitPullRequests.get(provenanceEntry.number);
    const mergedAt =
      node?.__typename === "PullRequest" && typeof node.mergedAt === "string"
        ? Date.parse(node.mergedAt)
        : Number.NaN;
    if (
      node?.__typename !== "PullRequest" ||
      !Number.isFinite(mergedAt) ||
      mergedAt > targetTimestamp
    ) {
      fail(
        `trusted provenance #${provenanceEntry.number}:${provenanceEntry.commit} is not a merged pull request by the source target cutoff`,
      );
    }
    const matchingPullRequestCommits = provenancePullRequestCommits
      .get(provenanceEntry.number)
      .filter((commit) => exactPatchEquivalent(cwd, graph, provenanceEntry.commit, commit));
    if (matchingPullRequestCommits.length !== 1) {
      fail(
        `trusted provenance #${provenanceEntry.number}:${provenanceEntry.commit} must match exactly one pull request commit`,
      );
    }
    const matches = sourceRecords.filter(
      (record) =>
        record.cherryPickOrigins.includes(provenanceEntry.commit) &&
        exactPatchEquivalent(cwd, graph, record.commit, provenanceEntry.commit),
    );
    if (matches.length !== 1) {
      fail(
        `trusted provenance #${provenanceEntry.number}:${provenanceEntry.commit} must have exactly one exact trailer-linked source commit`,
      );
    }
    const pullRequestCommit = matchingPullRequestCommits[0];
    const pullRequestPatch = patchFor(pullRequestCommit);
    const trailerPatch = patchFor(provenanceEntry.commit);
    for (const record of matches) {
      if (trustedPullRequestDetails.has(record.commit)) {
        fail(`source commit ${record.commit} has conflicting trusted pull request provenance`);
      }
      const evidence = trustedPullRequestEvidence.get(record.commit) ?? [];
      evidence.push({
        method: "trusted-pr-provenance",
        number: provenanceEntry.number,
        pullRequestCommit,
        sourceCommit: provenanceEntry.commit,
      });
      trustedPullRequestEvidence.set(record.commit, evidence);
      const targetPatch = patchFor(record.commit);
      trustedPullRequestDetails.set(record.commit, {
        method: "trusted-pr-provenance",
        number: provenanceEntry.number,
        patchId: trailerPatch?.patchId,
        paths: changedPaths(cwd, record.parents[0], record.commit),
        pullRequestCommit,
        pullRequestCommitDiffSha256: pullRequestPatch?.diffSha256,
        targetCommit: record.commit,
        targetDiffSha256: targetPatch?.diffSha256,
        trailerOrigin: provenanceEntry.commit,
        trailerOriginDiffSha256: trailerPatch?.diffSha256,
      });
    }
  }
  const trustedAdaptedPullRequestEvidence = new Map();
  const trustedAdaptedPullRequestDetails = new Map();
  for (const provenanceEntry of trustedAdaptedPullRequestProvenance) {
    const label =
      `trusted adapted provenance #${provenanceEntry.number}:` +
      `${provenanceEntry.originCommit}:${provenanceEntry.targetCommit}`;
    const node = explicitPullRequests.get(provenanceEntry.number);
    const mergedAt =
      node?.__typename === "PullRequest" && typeof node.mergedAt === "string"
        ? Date.parse(node.mergedAt)
        : Number.NaN;
    if (
      node?.__typename !== "PullRequest" ||
      !Number.isFinite(mergedAt) ||
      mergedAt > targetTimestamp
    ) {
      fail(`${label} is not a merged pull request by the source target cutoff`);
    }
    const pullRequestCommits = provenancePullRequestCommits.get(provenanceEntry.number);
    const matchingPullRequestCommits = trustedAdaptedPullRequestMemberMatches.get(
      provenanceEntry.targetCommit,
    );
    if (matchingPullRequestCommits.length > 1) {
      fail(`${label} matches more than one pull request commit`);
    }
    const originRecord = graph.get(provenanceEntry.originCommit);
    const targetRecord = sourceRecords.find(
      (record) => record.commit === provenanceEntry.targetCommit,
    );
    const originPatch = patchFor(provenanceEntry.originCommit);
    const targetPatch = patchFor(provenanceEntry.targetCommit);
    const matchingTargetPullRequestCommits = provenancePullRequestCommits
      .get(provenanceEntry.number)
      .filter((commit) => exactPatchEquivalent(cwd, graph, provenanceEntry.targetCommit, commit));
    if (
      originRecord?.parents.length !== 1 ||
      !targetRecord ||
      targetRecord.parents.length !== 1 ||
      targetRecord.cherryPickOrigins.length !== 1 ||
      targetRecord.cherryPickOrigins[0] !== provenanceEntry.originCommit ||
      targetRecord.adaptationOrigins.length > 0 ||
      matchingTargetPullRequestCommits.length > 0 ||
      !originPatch?.patchId ||
      !targetPatch?.patchId ||
      originPatch.patchId === targetPatch.patchId ||
      exactPatchEquivalent(cwd, graph, provenanceEntry.targetCommit, provenanceEntry.originCommit)
    ) {
      fail(`${label} is not a canonical non-equivalent cherry-pick adaptation`);
    }
    const originPaths = changedPaths(cwd, originRecord.parents[0], provenanceEntry.originCommit);
    const targetPaths = changedPaths(cwd, targetRecord.parents[0], provenanceEntry.targetCommit);
    if (
      originPaths.length === 0 ||
      targetPaths.length === 0 ||
      JSON.stringify(originPaths) !== JSON.stringify(targetPaths)
    ) {
      fail(`${label} must change exactly the same non-empty paths`);
    }
    if (matchingPullRequestCommits.length === 0) {
      const metadata = adaptedAggregatePullRequestMetadata.get(provenanceEntry.number);
      const metadataMergedAt = Date.parse(metadata?.mergedAt);
      if (
        !metadata ||
        metadataMergedAt !== mergedAt ||
        metadata.baseBranch !== "main" ||
        metadata.mergeCommit !== provenanceEntry.originCommit ||
        !pullRequestCommits.includes(metadata.headCommit) ||
        pullRequestCommits.includes(provenanceEntry.originCommit) ||
        !associations.get(provenanceEntry.originCommit)?.includes(provenanceEntry.number)
      ) {
        fail(`${label} is not the immutable associated squash merge for the pull request`);
      }
      const aggregateBaseCommit = uniqueMergeBase(
        cwd,
        metadata.baseCommit,
        metadata.headCommit,
        label,
      );
      const aggregateBaseAncestors = ancestorsOf(graph, aggregateBaseCommit);
      const aggregateHeadAncestors = ancestorsOf(graph, metadata.headCommit);
      const aggregateMemberCommits = oldestFirst(
        graph,
        [...aggregateHeadAncestors].filter((commit) => !aggregateBaseAncestors.has(commit)),
      );
      if (
        aggregateMemberCommits.some((commit) => graph.get(commit)?.parents.length !== 1) ||
        JSON.stringify(aggregateMemberCommits.toSorted()) !==
          JSON.stringify(pullRequestCommits.toSorted())
      ) {
        fail(`${label} pull request members do not exactly cover the aggregate ancestry`);
      }
      const aggregatePatch = commitRangePatch(cwd, aggregateBaseCommit, metadata.headCommit);
      const aggregatePaths = changedPaths(cwd, aggregateBaseCommit, metadata.headCommit);
      if (
        !aggregatePatch?.patchId ||
        aggregatePatch.patchId !== originPatch.patchId ||
        aggregatePatch.diffSha256 !== originPatch.diffSha256 ||
        JSON.stringify(aggregatePaths) !== JSON.stringify(originPaths)
      ) {
        fail(`${label} squash merge does not exactly reproduce the pull request aggregate`);
      }
      const exactPathEvidence = [];
      const adaptedPathEvidence = [];
      for (const path of aggregatePaths) {
        const aggregatePathPatch = commitRangePathPatch(
          cwd,
          aggregateBaseCommit,
          metadata.headCommit,
          path,
        );
        const mergePathPatch = commitPathPatch(cwd, graph, provenanceEntry.originCommit, path);
        const targetPathPatch = commitPathPatch(cwd, graph, provenanceEntry.targetCommit, path);
        if (
          !aggregatePathPatch?.patchId ||
          !mergePathPatch?.patchId ||
          !targetPathPatch?.patchId ||
          aggregatePathPatch.patchId !== mergePathPatch.patchId ||
          aggregatePathPatch.diffSha256 !== mergePathPatch.diffSha256
        ) {
          fail(`${label} lacks exact aggregate-to-squash evidence for ${path}`);
        }
        const commonEvidence = {
          aggregateDiffSha256: aggregatePathPatch.diffSha256,
          aggregateParent: aggregateBaseCommit,
          aggregatePatchId: aggregatePathPatch.patchId,
          mergeDiffSha256: mergePathPatch.diffSha256,
          mergeParent: mergePathPatch.parent,
          mergePatchId: mergePathPatch.patchId,
          path,
          targetDiffSha256: targetPathPatch.diffSha256,
          targetParent: targetPathPatch.parent,
          targetPatchId: targetPathPatch.patchId,
        };
        const exactTargetPath =
          aggregatePathPatch.patchId === targetPathPatch.patchId &&
          patchProducesPathState(
            cwd,
            aggregatePathPatch.patch,
            targetPathPatch.parent,
            provenanceEntry.targetCommit,
            path,
          ) &&
          patchProducesPathState(
            cwd,
            targetPathPatch.patch,
            aggregateBaseCommit,
            metadata.headCommit,
            path,
          );
        if (exactTargetPath) {
          exactPathEvidence.push({
            ...commonEvidence,
            proofMethod: "bidirectional-path-state",
          });
          continue;
        }
        if (aggregatePathPatch.patchId === targetPathPatch.patchId) {
          fail(`${label} has ambiguous adapted path evidence for ${path}`);
        }
        adaptedPathEvidence.push({
          ...commonEvidence,
          proofMethod: "operator-reviewed-conflict-adaptation",
        });
      }
      if (exactPathEvidence.length === 0 || adaptedPathEvidence.length === 0) {
        fail(`${label} must preserve exact aggregate paths and adapt at least one aggregate path`);
      }
      const pullRequestMemberEvidence = aggregateMemberCommits.map((commit) => {
        const record = graph.get(commit);
        const patch = patchFor(commit);
        if (!patch?.patchId) {
          fail(`${label} pull request member ${commit} has no one-parent patch evidence`);
        }
        return {
          author: record.author,
          commit,
          diffSha256: patch.diffSha256,
          parent: patch.parent,
          patchId: patch.patchId,
          paths: setSummary(changedPaths(cwd, patch.parent, commit)),
          tree: record.tree,
        };
      });
      const method = "trusted-pr-adapted-squash-aggregate-backport";
      trustedAdaptedPullRequestEvidence.set(provenanceEntry.targetCommit, [
        {
          method,
          number: provenanceEntry.number,
          pullRequestMemberCommits: aggregateMemberCommits,
          sourceCommit: provenanceEntry.originCommit,
        },
      ]);
      trustedAdaptedPullRequestDetails.set(provenanceEntry.targetCommit, {
        adaptedPathEvidence,
        aggregate: {
          baseCommit: aggregateBaseCommit,
          baseTree: graph.get(aggregateBaseCommit).tree,
          diffSha256: aggregatePatch.diffSha256,
          headCommit: metadata.headCommit,
          headTree: graph.get(metadata.headCommit).tree,
          patchId: aggregatePatch.patchId,
          paths: setSummary(aggregatePaths),
        },
        coverageEquation:
          `${aggregatePaths.length} target paths = ${exactPathEvidence.length} exact aggregate paths` +
          ` + ${adaptedPathEvidence.length} adapted aggregate paths`,
        exactPathEvidence,
        method,
        number: provenanceEntry.number,
        originAuthor: originRecord.author,
        originCommit: provenanceEntry.originCommit,
        pathPartitions: {
          adapted: setSummary(adaptedPathEvidence.map((entry) => entry.path)),
          exact: setSummary(exactPathEvidence.map((entry) => entry.path)),
        },
        paths: originPaths,
        pullRequest: metadata,
        pullRequestMemberEvidence,
        pullRequestMembers: setSummary(pullRequestCommits),
        squashMerge: {
          author: originRecord.author,
          commit: provenanceEntry.originCommit,
          diffSha256: originPatch.diffSha256,
          parent: originPatch.parent,
          parentTree: graph.get(originPatch.parent).tree,
          patchId: originPatch.patchId,
          paths: setSummary(originPaths),
          tree: originRecord.tree,
        },
        target: {
          author: targetRecord.author,
          commit: provenanceEntry.targetCommit,
          diffSha256: targetPatch.diffSha256,
          parent: targetPatch.parent,
          parentTree: graph.get(targetPatch.parent).tree,
          patchId: targetPatch.patchId,
          paths: setSummary(targetPaths),
          tree: targetRecord.tree,
        },
        targetCommit: provenanceEntry.targetCommit,
        targetCommitAuthor: targetRecord.author,
        targetDiffSha256: targetPatch.diffSha256,
        targetPatchId: targetPatch.patchId,
      });
      continue;
    }
    if (matchingPullRequestCommits.length !== 1) {
      fail(`${label} must match exactly one pull request commit`);
    }
    const pullRequestCommit = matchingPullRequestCommits[0];
    const pullRequestRecord = graph.get(pullRequestCommit);
    const pullRequestPatch = patchFor(pullRequestCommit);
    trustedAdaptedPullRequestEvidence.set(provenanceEntry.targetCommit, [
      {
        method: "trusted-pr-adapted-backport",
        number: provenanceEntry.number,
        pullRequestCommit,
        sourceCommit: provenanceEntry.originCommit,
      },
    ]);
    trustedAdaptedPullRequestDetails.set(provenanceEntry.targetCommit, {
      method: "trusted-pr-adapted-backport",
      number: provenanceEntry.number,
      originCommit: provenanceEntry.originCommit,
      originAuthor: originRecord.author,
      originDiffSha256: originPatch?.diffSha256,
      originPatchId: originPatch?.patchId,
      paths: originPaths,
      pullRequestCommit,
      pullRequestCommitAuthor: pullRequestRecord.author,
      pullRequestCommitDiffSha256: pullRequestPatch?.diffSha256,
      targetCommit: provenanceEntry.targetCommit,
      targetCommitAuthor: targetRecord.author,
      targetDiffSha256: targetPatch?.diffSha256,
      targetPatchId: targetPatch?.patchId,
    });
  }
  const trustedIntegratedPullRequestEvidence = new Map();
  const trustedIntegratedPullRequestDetails = new Map();
  for (const provenanceEntry of trustedIntegratedPullRequestProvenance) {
    const label = `trusted integrated provenance #${provenanceEntry.number}:${provenanceEntry.targetCommit}`;
    if (trustedPullRequestDetails.has(provenanceEntry.targetCommit)) {
      fail(`${label} conflicts with exact pull request provenance`);
    }
    const node = explicitPullRequests.get(provenanceEntry.number);
    const mergedAt =
      node?.__typename === "PullRequest" && typeof node.mergedAt === "string"
        ? Date.parse(node.mergedAt)
        : Number.NaN;
    const metadata = ownershipPullRequestMetadata.get(provenanceEntry.number);
    const metadataMergedAt = Date.parse(metadata?.mergedAt);
    const pullRequestCommits = provenancePullRequestCommits.get(provenanceEntry.number);
    if (
      node?.__typename !== "PullRequest" ||
      !Number.isFinite(mergedAt) ||
      mergedAt > targetTimestamp ||
      !metadata ||
      metadataMergedAt !== mergedAt ||
      !pullRequestCommits.includes(metadata.headCommit)
    ) {
      fail(`${label} is not an immutable merged pull request by the source target cutoff`);
    }
    if (provenanceEntry.sources.some((source) => !pullRequestCommits.includes(source.commit))) {
      fail(`${label} contains a source commit that is not an exact pull request member`);
    }
    const targetRecord = sourceRecords.find(
      (record) => record.commit === provenanceEntry.targetCommit,
    );
    const primarySourceCommit = targetRecord?.cherryPickOrigins[0];
    const primarySource = provenanceEntry.sources.find(
      (source) => source.commit === primarySourceCommit,
    );
    const integrationSources = provenanceEntry.sources.filter(
      (source) => source.commit !== primarySourceCommit,
    );
    const primaryRecord = graph.get(primarySourceCommit);
    const targetPatch = patchFor(provenanceEntry.targetCommit);
    const primaryPatch = patchFor(primarySourceCommit);
    const primaryParentCommit = primaryRecord?.parents[0];
    const targetParentCommit = targetRecord?.parents[0];
    const targetParentRecord = graph.get(targetParentCommit);
    const targetParentOrigins = targetParentRecord
      ? cherryPickOrigins(targetParentRecord.body)
      : [];
    const matchingTargetPullRequestCommits = pullRequestCommits.filter((commit) =>
      exactPatchEquivalent(cwd, graph, provenanceEntry.targetCommit, commit),
    );
    if (
      !targetRecord ||
      targetRecord.parents.length !== 1 ||
      targetRecord.cherryPickOrigins.length !== 1 ||
      targetRecord.adaptationOrigins.length > 0 ||
      !primarySource ||
      primarySourceCommit !== metadata.headCommit ||
      metadata.baseBranch !== "main" ||
      primaryRecord?.parents.length !== 1 ||
      !pullRequestCommits.includes(primaryParentCommit) ||
      integrationSources.length === 0 ||
      matchingTargetPullRequestCommits.length > 0 ||
      !primaryPatch?.patchId ||
      !targetPatch?.patchId ||
      primaryPatch.patchId === targetPatch.patchId ||
      exactPatchEquivalent(cwd, graph, provenanceEntry.targetCommit, primarySourceCommit) ||
      targetParentRecord?.parents.length !== 1 ||
      targetParentOrigins.length !== 1 ||
      targetParentOrigins[0] !== primaryParentCommit ||
      !exactPatchEquivalent(cwd, graph, primaryParentCommit, targetParentCommit)
    ) {
      fail(`${label} is not a canonical adapted multi-source pull request backport`);
    }
    const primaryAncestors = ancestorsOf(graph, primarySourceCommit);
    if (
      integrationSources.some(
        (source) =>
          graph.get(source.commit)?.parents.length !== 1 ||
          source.commit === primarySourceCommit ||
          !primaryAncestors.has(source.commit),
      )
    ) {
      fail(`${label} integration sources must be strict one-parent ancestors of the PR head`);
    }
    const primaryPaths = changedPaths(cwd, primaryRecord.parents[0], primarySourceCommit);
    const targetPaths = changedPaths(cwd, targetRecord.parents[0], provenanceEntry.targetCommit);
    if (
      primaryPaths.length === 0 ||
      targetPaths.length <= primaryPaths.length ||
      !primaryPaths.every((path) => targetPaths.includes(path))
    ) {
      fail(`${label} must add paths to the complete non-empty PR-head path set`);
    }
    const primaryExactPathEvidence = [];
    const primaryAdaptedPathEvidence = [];
    for (const path of primaryPaths) {
      const exactEvidence = exactPathPatchEvidence(
        cwd,
        graph,
        primarySourceCommit,
        provenanceEntry.targetCommit,
        path,
      );
      if (exactEvidence) {
        primaryExactPathEvidence.push(exactEvidence);
        continue;
      }
      const sourcePathPatch = commitPathPatch(cwd, graph, primarySourceCommit, path);
      const targetPathPatch = commitPathPatch(cwd, graph, provenanceEntry.targetCommit, path);
      if (
        !sourcePathPatch?.patchId ||
        !targetPathPatch?.patchId ||
        sourcePathPatch.patchId === targetPathPatch.patchId
      ) {
        fail(`${label} does not contain a reviewable PR-head adaptation for ${path}`);
      }
      primaryAdaptedPathEvidence.push({
        path,
        sourceCommit: primarySourceCommit,
        sourceDiffSha256: sourcePathPatch.diffSha256,
        sourceParent: sourcePathPatch.parent,
        sourcePatchId: sourcePathPatch.patchId,
        targetDiffSha256: targetPathPatch.diffSha256,
        targetParent: targetPathPatch.parent,
        targetPatchId: targetPathPatch.patchId,
      });
    }
    if (primaryExactPathEvidence.length === 0 || primaryAdaptedPathEvidence.length === 0) {
      fail(`${label} must preserve exact PR-head paths and adapt at least one PR-head path`);
    }
    const primaryPathSet = new Set(primaryPaths);
    const integrationPaths = targetPaths.filter((path) => !primaryPathSet.has(path));
    const integrationPathEvidence = integrationPaths.map((path) => {
      const matches = integrationSources
        .map((source) =>
          exactPathPatchEvidence(cwd, graph, source.commit, provenanceEntry.targetCommit, path),
        )
        .filter(Boolean);
      if (matches.length !== 1) {
        fail(`${label} must map integration path ${path} to exactly one explicit PR member`);
      }
      const [match] = matches;
      const sourcePathStateSha256 = pathStateSha256(cwd, match.sourceCommit, path);
      const primaryParentPathStateSha256 = pathStateSha256(cwd, primaryParentCommit, path);
      if (sourcePathStateSha256 !== primaryParentPathStateSha256) {
        fail(`${label} integration path ${path} did not survive unchanged into the PR head parent`);
      }
      return {
        ...match,
        primaryParentCommit,
        primaryParentPathStateSha256,
        sourcePathStateSha256,
      };
    });
    const integrationSourceDetails = integrationSources.map((source) => {
      const sourceRecord = graph.get(source.commit);
      const sourcePaths = changedPaths(cwd, sourceRecord.parents[0], source.commit);
      const contributionEvidence = integrationPathEvidence.filter(
        (entry) => entry.sourceCommit === source.commit,
      );
      if (contributionEvidence.length === 0) {
        fail(`${label} contains an explicit PR member with no exact integration path`);
      }
      const contributionPaths = contributionEvidence.map((entry) => entry.path).toSorted();
      const sourcePatch = patchFor(source.commit);
      return {
        author: sourceRecord.author,
        commit: source.commit,
        contributionPaths: setSummary(contributionPaths),
        diffSha256: sourcePatch?.diffSha256,
        omittedPaths: setSummary(sourcePaths.filter((path) => !contributionPaths.includes(path))),
        patchId: sourcePatch?.patchId,
        paths: setSummary(sourcePaths),
        ref: source.ref,
      };
    });
    trustedIntegratedPullRequestEvidence.set(provenanceEntry.targetCommit, [
      {
        integrationSourceCommits: integrationSources.map((source) => source.commit).toSorted(),
        method: "trusted-pr-adapted-integration-backport",
        number: provenanceEntry.number,
        sourceCommit: primarySourceCommit,
      },
    ]);
    trustedIntegratedPullRequestDetails.set(provenanceEntry.targetCommit, {
      coverageEquation: `${targetPaths.length} target paths = ${primaryPaths.length} PR-head paths + ${integrationPaths.length} exact integration paths`,
      integrationPathEvidence,
      integrationSources: integrationSourceDetails,
      method: "trusted-pr-adapted-integration-backport",
      number: provenanceEntry.number,
      originCommit: primarySourceCommit,
      pathPartitions: {
        adaptedPrimary: setSummary(primaryAdaptedPathEvidence.map((entry) => entry.path)),
        exactIntegration: setSummary(integrationPaths),
        exactPrimary: setSummary(primaryExactPathEvidence.map((entry) => entry.path)),
      },
      parentAlignment: {
        primaryParentCommit,
        primaryParentDiffSha256: patchFor(primaryParentCommit)?.diffSha256,
        primaryParentPatchId: patchFor(primaryParentCommit)?.patchId,
        targetParentCommit,
        targetParentDiffSha256: patchFor(targetParentCommit)?.diffSha256,
        targetParentPatchId: patchFor(targetParentCommit)?.patchId,
      },
      primaryAdaptedPathEvidence,
      primaryExactPathEvidence,
      primarySource: {
        author: primaryRecord.author,
        commit: primarySourceCommit,
        diffSha256: primaryPatch.diffSha256,
        patchId: primaryPatch.patchId,
        paths: setSummary(primaryPaths),
        ref: primarySource.ref,
      },
      pullRequest: metadata,
      pullRequestCommits: setSummary(pullRequestCommits),
      targetCommit: provenanceEntry.targetCommit,
      targetCommitAuthor: targetRecord.author,
      targetDiffSha256: targetPatch.diffSha256,
      targetPatchId: targetPatch.patchId,
      targetPaths: setSummary(targetPaths),
    });
  }
  const trustedPartialPullRequestEvidence = new Map();
  const trustedPartialPullRequestDetails = new Map();
  for (const provenanceEntry of trustedPartialPullRequestProvenance) {
    const node = explicitPullRequests.get(provenanceEntry.number);
    const mergedAt =
      node?.__typename === "PullRequest" && typeof node.mergedAt === "string"
        ? Date.parse(node.mergedAt)
        : Number.NaN;
    if (
      node?.__typename !== "PullRequest" ||
      !Number.isFinite(mergedAt) ||
      mergedAt > targetTimestamp
    ) {
      fail(
        `trusted partial provenance #${provenanceEntry.number}:${provenanceEntry.sourceCommit}:${provenanceEntry.targetCommit} is not a merged pull request by the source target cutoff`,
      );
    }
    if (
      !provenancePullRequestCommits
        .get(provenanceEntry.number)
        .includes(provenanceEntry.sourceCommit)
    ) {
      fail(
        `trusted partial source commit ${provenanceEntry.sourceCommit} does not belong to pull request #${provenanceEntry.number}`,
      );
    }
    if (!associations.get(provenanceEntry.sourceCommit)?.includes(provenanceEntry.number)) {
      fail(
        `trusted partial source commit ${provenanceEntry.sourceCommit} is not associated with pull request #${provenanceEntry.number}`,
      );
    }
    const sourceRecord = graph.get(provenanceEntry.sourceCommit);
    const targetRecord = sourceRecords.find(
      (record) => record.commit === provenanceEntry.targetCommit,
    );
    if (
      sourceRecord?.parents.length !== 1 ||
      !targetRecord ||
      targetRecord.parents.length !== 1 ||
      targetRecord.adaptationOrigins.length !== 1 ||
      targetRecord.adaptationOrigins[0] !== provenanceEntry.sourceCommit ||
      targetRecord.cherryPickOrigins.length !== 0 ||
      !targetRecord.references.includes(provenanceEntry.number) ||
      exactPatchEquivalent(cwd, graph, provenanceEntry.targetCommit, provenanceEntry.sourceCommit)
    ) {
      fail(
        `trusted partial provenance #${provenanceEntry.number}:${provenanceEntry.sourceCommit}:${provenanceEntry.targetCommit} is not a canonical non-equivalent partial backport`,
      );
    }
    const sourcePaths = changedPaths(cwd, sourceRecord.parents[0], provenanceEntry.sourceCommit);
    const targetPaths = changedPaths(cwd, targetRecord.parents[0], provenanceEntry.targetCommit);
    if (
      targetPaths.length === 0 ||
      targetPaths.length >= sourcePaths.length ||
      !targetPaths.every((path) => sourcePaths.includes(path))
    ) {
      fail(
        `trusted partial provenance #${provenanceEntry.number}:${provenanceEntry.sourceCommit}:${provenanceEntry.targetCommit} does not change a strict non-empty subset of source paths`,
      );
    }
    const pathEvidence = targetPaths.map((path) => {
      const sourcePatch = commitPathPatch(cwd, graph, provenanceEntry.sourceCommit, path);
      const targetPatch = commitPathPatch(cwd, graph, provenanceEntry.targetCommit, path);
      if (
        !sourcePatch?.patchId ||
        !targetPatch?.patchId ||
        sourcePatch.patchId !== targetPatch.patchId ||
        !patchProducesPathState(
          cwd,
          sourcePatch.patch,
          targetPatch.parent,
          provenanceEntry.targetCommit,
          path,
        ) ||
        !patchProducesPathState(
          cwd,
          targetPatch.patch,
          sourcePatch.parent,
          provenanceEntry.sourceCommit,
          path,
        )
      ) {
        fail(
          `trusted partial provenance #${provenanceEntry.number}:${provenanceEntry.sourceCommit}:${provenanceEntry.targetCommit} does not preserve the exact path patch for ${path}`,
        );
      }
      return {
        path,
        patchId: sourcePatch.patchId,
        sourceDiffSha256: sourcePatch.diffSha256,
        targetDiffSha256: targetPatch.diffSha256,
      };
    });
    trustedPartialPullRequestEvidence.set(provenanceEntry.targetCommit, [
      {
        method: "trusted-pr-partial-backport",
        number: provenanceEntry.number,
        sourceCommit: provenanceEntry.sourceCommit,
      },
    ]);
    trustedPartialPullRequestDetails.set(provenanceEntry.targetCommit, {
      method: "trusted-pr-partial-backport",
      number: provenanceEntry.number,
      omittedPaths: sourcePaths.filter((path) => !targetPaths.includes(path)),
      pathEvidence,
      sourceCommit: provenanceEntry.sourceCommit,
      sourceDiffSha256: patchFor(provenanceEntry.sourceCommit)?.diffSha256,
      sourcePaths,
      targetCommit: provenanceEntry.targetCommit,
      targetDiffSha256: patchFor(provenanceEntry.targetCommit)?.diffSha256,
      targetPaths,
    });
  }
  const unresolved = [];
  const revertEdges = [];
  const externalRevertStates = new Map();

  function externalRevertState(commit, seen = new Set()) {
    if (externalRevertStates.has(commit)) {
      return externalRevertStates.get(commit);
    }
    if (seen.has(commit)) {
      return { reason: `cyclic external revert lineage at ${commit}` };
    }
    const record = graph.get(commit);
    if (!record) {
      return { reason: `external revert target ${commit} is unavailable` };
    }
    const [target] = revertedCommits(record.message);
    if (!target) {
      if (isRevertMessage(record.message)) {
        return {
          reason: `external revert ${commit} is missing a canonical full-SHA trailer`,
        };
      }
      const state = {
        depth: 0,
        pullRequests: associations.get(commit) ?? [],
        references: localReferencesIn(record.message),
        rootCommit: commit,
      };
      externalRevertStates.set(commit, state);
      return state;
    }
    const targetRecord = graph.get(target);
    if (
      record.parents.length !== 1 ||
      !targetRecord ||
      targetRecord.parents.length !== 1 ||
      !ancestorsOf(graph, record.parents[0]).has(target) ||
      !exactPatchEquivalent(cwd, graph, target, commit, { inverse: true })
    ) {
      return {
        reason: `external revert ${commit} does not exactly invert ancestor ${target}`,
      };
    }
    const targetState = externalRevertState(target, new Set([...seen, commit]));
    if (targetState.reason) {
      return targetState;
    }
    const state = { ...targetState, depth: targetState.depth + 1 };
    externalRevertStates.set(commit, state);
    return state;
  }

  for (const record of sourceRecords) {
    const targets = revertedCommits(record.message);
    if (targets.length === 0) {
      if (isRevertMessage(record.message)) {
        unresolved.push({
          commit: record.commit,
          kind: "revert",
          reason: "revert subject is missing a canonical full-SHA trailer",
        });
      }
      continue;
    }
    for (const target of targets) {
      const targetRecord = graph.get(target);
      const parent = record.parents[0];
      const revertEvidence = verifiedRevertEvidence(
        cwd,
        graph,
        record,
        target,
        canonicalAssociationsFor(record.commit),
      );
      if (
        record.parents.length !== 1 ||
        !targetRecord ||
        targetRecord.parents.length !== 1 ||
        !ancestorsOf(graph, parent).has(target) ||
        !revertEvidence
      ) {
        unresolved.push({
          commit: record.commit,
          kind: "revert",
          reason: `revert lacks verified exact-inverse or GitHub-associated subject-bound squash evidence for ancestor ${target}`,
        });
        continue;
      }
      revertEdges.push({
        ...revertEvidence,
        revertCommit: record.commit,
        targetCommit: target,
      });
      if (revertEvidence.proofMethod) {
        record.revertEvidence.push({ ...revertEvidence, targetCommit: target });
      }
      if (!sourceCommitSet.has(target)) {
        const state = externalRevertState(target);
        if (state.reason) {
          unresolved.push({
            commit: record.commit,
            kind: "revert",
            reason: state.reason,
          });
        } else if (state.depth % 2 === 0) {
          record.revertedExternalPullRequests = [
            ...new Set([...record.revertedExternalPullRequests, ...state.pullRequests]),
          ].toSorted((left, right) => left - right);
          record.revertedExternalReferences = [
            ...new Set([...record.revertedExternalReferences, ...state.references]),
          ].toSorted((left, right) => left - right);
        }
      }
    }
  }
  const active = activeCommitsAfterReverts(sourceCommits, revertEdges);
  for (const targetCommit of trustedPullRequestDetails.keys()) {
    if (!active.has(targetCommit)) {
      fail(`trusted provenance target commit ${targetCommit} is not active in the source range`);
    }
  }
  for (const provenanceEntry of trustedAdaptedPullRequestProvenance) {
    if (!active.has(provenanceEntry.targetCommit)) {
      fail(
        `trusted adapted target commit ${provenanceEntry.targetCommit} is not active in the source range`,
      );
    }
  }
  for (const provenanceEntry of trustedIntegratedPullRequestProvenance) {
    if (!active.has(provenanceEntry.targetCommit)) {
      fail(
        `trusted integrated target commit ${provenanceEntry.targetCommit} is not active in the source range`,
      );
    }
  }
  for (const provenanceEntry of trustedPartialPullRequestProvenance) {
    if (!active.has(provenanceEntry.targetCommit)) {
      fail(
        `trusted partial target commit ${provenanceEntry.targetCommit} is not active in the source range`,
      );
    }
  }

  const associatedProvenanceCandidates = provenanceCandidates.filter(
    (commit) => associations.get(commit).length > 0,
  );
  const provenanceByPatch = new Map();
  for (const commit of associatedProvenanceCandidates) {
    const patch = patchFor(commit);
    if (!patch?.patchId) {
      continue;
    }
    const values = provenanceByPatch.get(patch.patchId) ?? [];
    values.push(commit);
    provenanceByPatch.set(patch.patchId, values);
  }

  const ownership = new Map();
  for (const record of sourceRecords) {
    const evidence = [
      ...(trustedAdaptedPullRequestEvidence.get(record.commit) ?? []),
      ...(trustedIntegratedPullRequestEvidence.get(record.commit) ?? []),
      ...(trustedPartialPullRequestEvidence.get(record.commit) ?? []),
      ...(trustedPullRequestEvidence.get(record.commit) ?? []),
    ];
    const comparisonMergeCommitOwner = comparisonMergeCommitOwners.get(record.commit);
    if (comparisonMergeCommitOwner !== undefined) {
      evidence.push({
        method: "comparison-merge-commit",
        number: comparisonMergeCommitOwner,
        sourceCommit: record.commit,
      });
    }
    for (const number of record.associatedPullRequests) {
      if (number === comparisonMergeCommitOwner) {
        continue;
      }
      evidence.push({ method: "association", number, sourceCommit: record.commit });
    }
    for (const number of record.explicitPullRequestReferences) {
      const node = explicitPullRequests.get(number);
      const mergedAt =
        node?.__typename === "PullRequest" && typeof node.mergedAt === "string"
          ? Date.parse(node.mergedAt)
          : Number.NaN;
      const associatedByCutoff = record.associatedPullRequests.includes(number);
      const required = requiredPullRequestReferences(record.subject, record.body).has(number);
      if (!associatedByCutoff && node?.__typename === "Issue" && !required) {
        continue;
      }
      if (
        !associatedByCutoff &&
        (node?.__typename !== "PullRequest" ||
          !Number.isFinite(mergedAt) ||
          mergedAt > targetTimestamp)
      ) {
        unresolved.push({
          commit: record.commit,
          kind: "ownership",
          pullRequests: [number],
          reason: `strict ownership reference #${number} is not a merged pull request by the source target cutoff`,
        });
        continue;
      }
      evidence.push({ method: "explicit-reference", number, sourceCommit: record.commit });
    }
    for (const origin of record.cherryPickOrigins) {
      const originRecord = graph.get(origin);
      if (!originRecord || !exactPatchEquivalent(cwd, graph, record.commit, origin)) {
        record.nonEquivalentCherryPickOrigins.push(origin);
        continue;
      }
      record.verifiedCherryPickOrigins.push(origin);
      for (const number of associations.get(origin) ?? []) {
        evidence.push({ method: "cherry-origin-association", number, sourceCommit: origin });
      }
    }
    const patch = patchFor(record.commit);
    const trustedCandidates = (provenanceByPatch.get(patch?.patchId) ?? []).filter((candidate) =>
      exactPatchEquivalent(cwd, graph, record.commit, candidate),
    );
    for (const candidate of trustedCandidates) {
      for (const number of associations.get(candidate) ?? []) {
        evidence.push({
          method: "trusted-patch-association",
          number,
          sourceCommit: candidate,
        });
      }
    }
    const pullRequests = [...new Set(evidence.map((entry) => entry.number))].toSorted(
      (left, right) => left - right,
    );
    const nonEquivalentOriginPullRequests = [
      ...new Set(
        record.nonEquivalentCherryPickOrigins.flatMap((origin) => associations.get(origin) ?? []),
      ),
    ].toSorted((left, right) => left - right);
    const adaptedDetails =
      trustedAdaptedPullRequestDetails.get(record.commit) ??
      trustedIntegratedPullRequestDetails.get(record.commit);
    const partialDetails = trustedPartialPullRequestDetails.get(record.commit);
    const comparisonMergeOwnsRecord =
      comparisonMergeCommitOwner !== undefined &&
      pullRequests.length === 1 &&
      pullRequests[0] === comparisonMergeCommitOwner;
    if (
      record.adaptationOrigins.length > 0 &&
      (!partialDetails ||
        record.adaptationOrigins.length !== 1 ||
        record.adaptationOrigins[0] !== partialDetails.sourceCommit)
    ) {
      unresolved.push({
        commit: record.commit,
        kind: "ownership",
        pullRequests,
        reason: "partial backport provenance requires reviewed partial ownership",
      });
      continue;
    }
    if (
      record.nonEquivalentCherryPickOrigins.length > 0 &&
      !comparisonMergeOwnsRecord &&
      (!adaptedDetails ||
        record.nonEquivalentCherryPickOrigins.length !== 1 ||
        record.nonEquivalentCherryPickOrigins[0] !== adaptedDetails.originCommit)
    ) {
      unresolved.push({
        commit: record.commit,
        kind: "ownership",
        pullRequests: [...new Set([...pullRequests, ...nonEquivalentOriginPullRequests])].toSorted(
          (left, right) => left - right,
        ),
        reason: "non-equivalent cherry-pick provenance requires reviewed adaptation ownership",
      });
      continue;
    }
    if (pullRequests.length > 1) {
      unresolved.push({
        commit: record.commit,
        kind: "ownership",
        pullRequests,
        reason: "ownership evidence resolves to more than one pull request",
      });
      continue;
    }
    ownership.set(record.commit, {
      evidence: evidence.filter((entry) => entry.number === pullRequests[0]),
      pullRequests,
    });
  }

  const shippedMatches = new Map();
  const shippedBaselineEvidence = new Map();
  const addShippedMatch = (commit, evidence) => {
    const values = shippedMatches.get(commit) ?? [];
    if (!values.some((value) => value.ref === evidence.ref)) {
      values.push(evidence);
      shippedMatches.set(commit, values);
    }
  };
  for (const baseline of shippedHistoryByRef) {
    const baselineEdges = [];
    for (const commit of baseline.commits) {
      const record = graph.get(commit);
      const targets = revertedCommits(record.message);
      if (targets.length === 0) {
        if (isRevertMessage(record.message)) {
          fail(
            `shipped baseline ${baseline.ref} revert ${commit} is missing a canonical full-SHA trailer`,
          );
        }
        continue;
      }
      for (const target of targets) {
        const targetRecord = graph.get(target);
        const parent = record.parents[0];
        const revertEvidence = verifiedRevertEvidence(
          cwd,
          graph,
          record,
          target,
          canonicalAssociationsFor(commit),
        );
        if (
          record.parents.length !== 1 ||
          !targetRecord ||
          targetRecord.parents.length !== 1 ||
          !ancestorsOf(graph, parent).has(target) ||
          !revertEvidence
        ) {
          fail(
            `shipped baseline ${baseline.ref} revert ${commit} lacks verified exact-inverse or GitHub-associated subject-bound squash evidence for ${target}`,
          );
        }
        baselineEdges.push({ ...revertEvidence, revertCommit: commit, targetCommit: target });
      }
    }
    const activeBaselineCommits = activeCommitsAfterReverts(baseline.commits, baselineEdges);
    const revertEdgeRecords = baselineEdges.map((edge) => ({
      revertCommit: edge.revertCommit,
      targetCommit: edge.targetCommit,
      proofMethod: edge.proofMethod,
      ...(edge.associatedPullRequests
        ? { associatedPullRequests: edge.associatedPullRequests }
        : {}),
      ...(edge.quotedSubject ? { quotedSubject: edge.quotedSubject } : {}),
    }));
    shippedBaselineEvidence.set(baseline.ref, {
      history: setSummary(baseline.commits),
      revertEdges: orderedRecordSummary(
        revertEdgeRecords,
        (left, right) =>
          left.revertCommit.localeCompare(right.revertCommit) ||
          left.targetCommit.localeCompare(right.targetCommit),
      ),
      activeCommits: setSummary(activeBaselineCommits),
    });
    const byPatch = new Map();
    for (const commit of activeBaselineCommits) {
      const patch = patchFor(commit);
      if (!patch?.patchId) {
        continue;
      }
      const values = byPatch.get(patch.patchId) ?? [];
      values.push(commit);
      byPatch.set(patch.patchId, values);
    }
    for (const record of sourceRecords) {
      if (!active.has(record.commit) || record.parents.length !== 1) {
        continue;
      }
      const patch = patchFor(record.commit);
      const matches = (byPatch.get(patch?.patchId) ?? []).filter((candidate) =>
        exactPatchEquivalent(cwd, graph, record.commit, candidate),
      );
      if (matches.length > 0) {
        addShippedMatch(record.commit, {
          commits: matches.toSorted(),
          method: "baseline-commit-patch",
          ref: baseline.ref,
        });
        continue;
      }
      if (!patch) {
        continue;
      }
      const candidate = {
        ...patch,
        commit: record.commit,
        paths: changedPaths(cwd, patch.parent, record.commit),
        tree: record.tree,
      };
      const treeProof = candidatePatchTreeProof(cwd, graph, baseline.commit, candidate);
      if (treeProof) {
        addShippedMatch(record.commit, {
          commits: [baseline.commit],
          method: "baseline-final-tree",
          ref: baseline.ref,
          treeProof,
        });
      }
    }
    let run = [];
    const flushRun = () => {
      if (run.length < 2) {
        run = [];
        return;
      }
      const first = run[0];
      const last = run.at(-1);
      const patch = commitRangePatch(cwd, first.parents[0], last.commit);
      if (patch) {
        const candidate = {
          ...patch,
          commit: last.commit,
          paths: changedPaths(cwd, patch.parent, last.commit),
          tree: last.tree,
        };
        const treeProof = candidatePatchTreeProof(cwd, graph, baseline.commit, candidate);
        if (treeProof) {
          const sourceMatches = run.map((record) => record.commit);
          for (const record of run) {
            addShippedMatch(record.commit, {
              commits: [baseline.commit],
              method: "baseline-final-tree-pull-request-aggregate",
              ref: baseline.ref,
              sourceCommits: sourceMatches,
              treeProof,
            });
          }
        }
      }
      run = [];
    };
    for (const record of sourceRecords) {
      const owner = ownership.get(record.commit);
      const number = owner?.pullRequests.length === 1 ? owner.pullRequests[0] : undefined;
      const previous = run.at(-1);
      const previousOwner = previous ? ownership.get(previous.commit) : undefined;
      const previousNumber =
        previousOwner?.pullRequests.length === 1 ? previousOwner.pullRequests[0] : undefined;
      if (
        !active.has(record.commit) ||
        record.parents.length !== 1 ||
        number === undefined ||
        (previous &&
          (record.parents[0] !== previous.commit ||
            previousNumber === undefined ||
            number !== previousNumber))
      ) {
        flushRun();
      }
      if (active.has(record.commit) && record.parents.length === 1 && number !== undefined) {
        run.push(record);
      }
    }
    flushRun();
  }

  const commits = [];
  for (const record of sourceRecords) {
    const owner = ownership.get(record.commit) ?? { evidence: [], pullRequests: [] };
    let disposition;
    let mergeResolution;
    if (unresolved.some((entry) => entry.commit === record.commit)) {
      disposition = "unresolved";
    } else if (!active.has(record.commit)) {
      disposition = "reverted";
    } else if (shippedMatches.has(record.commit)) {
      disposition = "shipped";
    } else if (owner.pullRequests.length === 1) {
      disposition = "pull-request";
    } else if (record.parents.length > 1) {
      mergeResolution = mergeResolutionDigest(cwd, record.commit);
      if (record.parents.length === 2 && !mergeResolution) {
        disposition = "structural-merge";
      } else {
        disposition = "unresolved";
        unresolved.push({
          commit: record.commit,
          kind: "merge-resolution",
          reason:
            record.parents.length > 2
              ? "octopus merge requires reviewed provenance"
              : "merge resolution content has no singular ownership",
        });
      }
    } else {
      disposition = "direct";
    }
    const patch = record.parents.length === 1 ? patchFor(record.commit) : undefined;
    commits.push({
      adaptationOrigins: record.adaptationOrigins,
      associatedPullRequests: record.associatedPullRequests,
      authorEmail: record.author.email,
      authorName: record.author.name,
      body: record.body,
      cherryPickOrigins: record.cherryPickOrigins,
      commit: record.commit,
      diffSha256: patch?.diffSha256,
      disposition,
      evidence: owner.evidence,
      explicitPullRequestReferences: owner.evidence
        .filter((entry) => entry.method === "explicit-reference")
        .map((entry) => entry.number),
      mergeResolutionDiffSha256: mergeResolution,
      nonEquivalentCherryPickOrigins: record.nonEquivalentCherryPickOrigins,
      parents: record.parents,
      patchId: patch?.patchId,
      pullRequests: owner.pullRequests,
      references: record.references,
      ...(record.revertEvidence.length > 0 ? { revertEvidence: record.revertEvidence } : {}),
      revertedExternalPullRequests: record.revertedExternalPullRequests,
      revertedExternalReferences: record.revertedExternalReferences,
      shippedEvidence: shippedMatches.get(record.commit) ?? [],
      subject: record.subject,
      topoIndex: record.topoIndex,
      tree: record.tree,
      trustedAdaptedPullRequest: trustedAdaptedPullRequestDetails.get(record.commit),
      ...(trustedIntegratedPullRequestDetails.has(record.commit)
        ? {
            trustedIntegratedPullRequest: trustedIntegratedPullRequestDetails.get(record.commit),
          }
        : {}),
      trustedPartialPullRequest: trustedPartialPullRequestDetails.get(record.commit),
      trustedPullRequest: trustedPullRequestDetails.get(record.commit),
      verifiedCherryPickOrigins: record.verifiedCherryPickOrigins,
    });
  }

  const includedPullRequests = commits
    .filter((commit) => commit.disposition === "pull-request")
    .flatMap((commit) => commit.pullRequests);
  const shippedPullRequests = commits
    .filter((commit) => commit.disposition === "shipped")
    .flatMap((commit) => commit.pullRequests);
  const revertedPullRequests = commits
    .filter((commit) => commit.disposition === "reverted")
    .flatMap((commit) => commit.pullRequests);
  const directCommits = commits
    .filter((commit) => commit.disposition === "direct")
    .map((commit) => commit.commit);
  const manifestDirectCommits = commits
    .filter(
      (commit) =>
        (commit.disposition === "direct" || commit.disposition === "pull-request") &&
        commit.parents.length === 1 &&
        commit.associatedPullRequests.length === 0,
    )
    .map((commit) => commit.commit);
  const directOwnershipOverlap = commits
    .filter(
      (commit) =>
        commit.disposition === "pull-request" &&
        commit.parents.length === 1 &&
        commit.associatedPullRequests.length === 0,
    )
    .map((commit) => commit.commit);
  const structuralMerges = commits
    .filter((commit) => commit.disposition === "structural-merge")
    .map((commit) => commit.commit);
  const shippedCommits = commits
    .filter((commit) => commit.disposition === "shipped")
    .map((commit) => commit.commit);
  const revertedCommitMembers = commits
    .filter((commit) => commit.disposition === "reverted")
    .map((commit) => commit.commit);
  const unresolvedCommits = commits
    .filter((commit) => commit.disposition === "unresolved")
    .map((commit) => commit.commit);
  const partitions = {
    commits: {
      direct: setSummary(directCommits),
      directOwnershipOverlap: setSummary(directOwnershipOverlap),
      exclusiveDirect: setSummary(directCommits),
      manifestDirect: setSummary(manifestDirectCommits),
      pullRequest: setSummary(
        commits
          .filter((commit) => commit.disposition === "pull-request")
          .map((commit) => commit.commit),
      ),
      reverted: setSummary(revertedCommitMembers),
      shipped: setSummary(shippedCommits),
      structuralMerge: setSummary(structuralMerges),
      unresolved: setSummary(unresolvedCommits),
      universe: setSummary(sourceCommits),
    },
    pullRequests: {
      included: setSummary(includedPullRequests, (left, right) => left - right),
      reverted: setSummary(revertedPullRequests, (left, right) => left - right),
      shipped: setSummary(shippedPullRequests, (left, right) => left - right),
    },
    directReconciliation: {
      equation: `${manifestDirectCommits.length} manifest-direct - ${directOwnershipOverlap.length} PR-owned overlap = ${directCommits.length} exclusive-direct`,
    },
  };
  if (
    partitions.commits.manifestDirect.count - partitions.commits.directOwnershipOverlap.count !==
    partitions.commits.exclusiveDirect.count
  ) {
    fail("release source inventory direct commit reconciliation is inconsistent");
  }
  const covered =
    partitions.commits.direct.count +
    partitions.commits.pullRequest.count +
    partitions.commits.reverted.count +
    partitions.commits.shipped.count +
    partitions.commits.structuralMerge.count +
    partitions.commits.unresolved.count;
  if (covered !== partitions.commits.universe.count) {
    fail(
      `release source inventory partition covers ${covered} of ${partitions.commits.universe.count} commits`,
    );
  }
  const comparisonPullRequestMemberOverlapEvidence = new Map();
  let comparison;
  if (comparisonUniverse) {
    const canonical = new Set(partitions.pullRequests.included.members);
    const searchUniverse = new Set(comparisonUniverse.pullRequests);
    const searchMetadata = new Map(
      comparisonUniverse.records.map((record) => [record.number, record]),
    );
    const canonicalOnly = [...canonical]
      .filter((number) => !searchUniverse.has(number))
      .toSorted((left, right) => left - right);
    if (canonicalOnly.length > 0 && typeof resolvePullRequestMetadata !== "function") {
      fail("release source inventory requires a pull request metadata resolver");
    }
    const supplementalMetadata =
      canonicalOnly.length === 0
        ? new Map()
        : normalizePullRequestMetadata(resolvePullRequestMetadata(canonicalOnly), canonicalOnly);
    const targetAssociatedOutsideSearch = canonicalOnly.map((number) => {
      const metadata = supplementalMetadata.get(number);
      const mergedAt = Date.parse(metadata.mergedAt);
      const targetCommits = commits
        .filter((commit) => commit.pullRequests.includes(number))
        .map((commit) => commit.commit)
        .toSorted();
      const mergeCommitInTarget = sourceAncestors.has(metadata.mergeCommit);
      let omissionReason;
      if (metadata.baseBranch !== comparisonUniverse.baseBranch) {
        omissionReason = "base-outside-search";
      } else if (mergedAt < comparisonUniverse.window.startTimestamp) {
        omissionReason = "merged-before-search-window";
      } else if (
        metadata.baseBranch === comparisonUniverse.baseBranch &&
        mergedAt > comparisonUniverse.window.endTimestamp &&
        mergedAt <= comparisonUniverse.window.endTimestamp + 1_000 &&
        mergeCommitInTarget
      ) {
        omissionReason = "merged-after-search-cutoff";
      }
      if (!omissionReason || targetCommits.length === 0) {
        fail(`canonical pull request #${number} is absent from the exact comparison search`);
      }
      return {
        ...metadata,
        mergeCommitInTarget,
        omissionReason,
        targetCommits,
      };
    });
    const universe = new Set([...searchUniverse, ...canonicalOnly]);
    const overlap = [...universe].filter((number) => canonical.has(number));
    const comparisonOnly = new Set([...universe].filter((number) => !canonical.has(number)));
    const remaining = new Set(comparisonOnly);
    const take = (members) => {
      const values = [];
      for (const number of members) {
        if (remaining.delete(number)) {
          values.push(number);
        }
      }
      return values.toSorted((left, right) => left - right);
    };
    const netReverted = take(partitions.pullRequests.reverted.members);
    const shipped = take(partitions.pullRequests.shipped.members);
    const associatedBoundary = take(allAssociations.get(mergeBase) ?? []);
    const sameSecondAncestralBoundary = take(
      [...remaining].filter((number) => {
        const metadata = searchMetadata.get(number);
        const mergedAt = Date.parse(metadata?.mergedAt);
        return (
          Number.isFinite(mergedAt) &&
          mergedAt >= comparisonUniverse.window.startTimestamp &&
          mergedAt < comparisonUniverse.window.startTimestamp + 1_000 &&
          boundaryAncestors.has(metadata.mergeCommit)
        );
      }),
    );
    const boundary = [...associatedBoundary, ...sameSecondAncestralBoundary].toSorted(
      (left, right) => left - right,
    );
    const postForkNotBackported = [...remaining].toSorted((left, right) => left - right);
    const postForkNotBackportedSet = new Set(postForkNotBackported);
    for (const entry of trustedComparisonPullRequestMemberOverlaps) {
      if (!postForkNotBackportedSet.has(entry.number)) {
        fail(
          `trusted comparison member overlap #${entry.number}:${entry.sourceCommit}:${entry.targetCommit}:${entry.witnessCommit} is not a comparison-only post-fork pull request`,
        );
      }
    }
    if (postForkNotBackported.length > 0 && typeof resolvePullRequestCommits !== "function") {
      fail("release source inventory requires a pull request commit resolver");
    }
    const postForkCommitLists =
      postForkNotBackported.length === 0
        ? new Map()
        : normalizePullRequestCommits(
            resolvePullRequestCommits(postForkNotBackported),
            postForkNotBackported,
          );
    const postForkMetadataCommits = postForkNotBackported.flatMap((number) => {
      const metadata = searchMetadata.get(number);
      if (!metadata) {
        fail(`comparison-only pull request #${number} has no exact search metadata`);
      }
      return [metadata.baseCommit, metadata.headCommit, metadata.mergeCommit];
    });
    const postForkCandidateCommits = [
      ...new Set([...postForkMetadataCommits, ...[...postForkCommitLists.values()].flat()]),
    ].toSorted();
    extendGraphWithCommitsAndParents(cwd, graph, postForkCandidateCommits);
    const comparisonPatches = new Map();
    const comparisonCandidatesByPullRequest = new Map();
    const patchMatchesByPullRequest = new Map();
    const suppressedAmbiguousPatchMatchesByPullRequest = new Map();
    const suppressedCommonAncestryPatchMatchesByPullRequest = new Map();
    const pullRequestCleanupContexts = new Map();
    const branchLocalCleanupCache = new Map();
    const commonAncestrySurvivalProofCache = new Map();
    const addPatchMatch = (number, match) => {
      const matches = patchMatchesByPullRequest.get(number) ?? [];
      matches.push(match);
      patchMatchesByPullRequest.set(number, matches);
    };
    const addSuppressedAmbiguousPatchMatch = (number, match) => {
      const matches = suppressedAmbiguousPatchMatchesByPullRequest.get(number) ?? [];
      matches.push(match);
      suppressedAmbiguousPatchMatchesByPullRequest.set(number, matches);
    };
    const addSuppressedCommonAncestryPatchMatch = (number, match) => {
      const matches = suppressedCommonAncestryPatchMatchesByPullRequest.get(number) ?? [];
      matches.push(match);
      suppressedCommonAncestryPatchMatchesByPullRequest.set(number, matches);
    };
    const aggregateBaseStateProofFor = (number) => {
      const context = pullRequestCleanupContexts.get(number);
      if (!context.aggregateBaseStateProofComputed) {
        context.aggregateBaseStateProof = aggregateBaseStateProof(
          cwd,
          context.baseCommit,
          context.headCommit,
          sourceTarget,
          [...context.aggregatePaths],
        );
        context.aggregateBaseStateProofComputed = true;
      }
      return context.aggregateBaseStateProof;
    };
    const addComparisonPatch = (candidate) => {
      if (!candidate.patchId) {
        return;
      }
      const candidates = comparisonPatches.get(candidate.patchId) ?? [];
      candidates.push(candidate);
      comparisonPatches.set(candidate.patchId, candidates);
      const pullRequestCandidates = comparisonCandidatesByPullRequest.get(candidate.number) ?? [];
      pullRequestCandidates.push(candidate);
      comparisonCandidatesByPullRequest.set(candidate.number, pullRequestCandidates);
    };
    const candidateIsBranchLocalCleanup = (candidate) => {
      if (candidate.kind === "pull-request-aggregate") {
        return false;
      }
      const context = pullRequestCleanupContexts.get(candidate.number);
      if (!context?.members.has(candidate.commit)) {
        return false;
      }
      const cacheKey = `${candidate.number}:${candidate.commit}`;
      if (branchLocalCleanupCache.has(cacheKey)) {
        return branchLocalCleanupCache.get(cacheKey);
      }
      const baseRecord = graph.get(context.baseCommit);
      const headRecord = graph.get(context.headCommit);
      const proofPatch = candidateZeroContextPatch(cwd, candidate);
      const isCleanup =
        proofPatch !== "" &&
        baseRecord &&
        headRecord &&
        patchRoundTripRestoresTree(
          cwd,
          context.baseCommit,
          baseRecord.tree,
          proofPatch,
          ["--unidiff-zero"],
          { exactPatchPaths: candidate.paths },
        ) &&
        patchRoundTripRestoresTree(
          cwd,
          context.headCommit,
          headRecord.tree,
          proofPatch,
          ["--unidiff-zero"],
          { exactPatchPaths: candidate.paths },
        );
      branchLocalCleanupCache.set(cacheKey, Boolean(isCleanup));
      return Boolean(isCleanup);
    };
    const commonAncestrySurvivalProofFor = (candidate) => {
      const context = pullRequestCleanupContexts.get(candidate.number);
      if (!context) {
        return undefined;
      }
      const cacheKey = `${candidate.number}:${candidate.kind}:${candidate.commit}`;
      if (commonAncestrySurvivalProofCache.has(cacheKey)) {
        return commonAncestrySurvivalProofCache.get(cacheKey);
      }
      const pathHistoryOutput = git(cwd, [
        "rev-list",
        "--first-parent",
        "--reverse",
        `${context.sharedAncestryCommit}..${sourceTarget}`,
        "--",
        ...candidate.paths,
      ]).trim();
      const pathHistory = [
        context.sharedAncestryCommit,
        ...(pathHistoryOutput === "" ? [] : pathHistoryOutput.split("\n")),
      ];
      extendGraphWithCommitsAndParents(cwd, graph, pathHistory);
      const survivalRecords = pathHistory.map((commit) =>
        candidatePatchTreeProof(cwd, graph, commit, candidate),
      );
      const proof = survivalRecords.every(Boolean)
        ? {
            paths: setSummary(candidate.paths),
            sharedAncestryCommit: context.sharedAncestryCommit,
            sourceTarget,
            survival: recordSummary(
              survivalRecords.map((record) => ({
                commit: record.targetCommit,
                proofMethod: record.proofMethod,
                tree: record.targetTree,
              })),
            ),
          }
        : undefined;
      commonAncestrySurvivalProofCache.set(cacheKey, proof);
      return proof;
    };
    for (const number of postForkNotBackported) {
      const metadata = searchMetadata.get(number);
      const pullRequestCommits = postForkCommitLists.get(number);
      if (!pullRequestCommits.includes(metadata.headCommit)) {
        fail(`comparison-only pull request #${number} commit list omits its exact head`);
      }
      const pullRequestCommitSet = new Set(pullRequestCommits);
      const aggregateBaseCommit = uniqueMergeBase(
        cwd,
        metadata.baseCommit,
        metadata.headCommit,
        `comparison-only pull request #${number}`,
      );
      const aggregatePaths = changedPaths(cwd, aggregateBaseCommit, metadata.headCommit);
      const sharedAncestryCommit = uniqueMergeBase(
        cwd,
        sourceTarget,
        metadata.mergeCommit,
        `comparison-only pull request #${number} and source target`,
      );
      extendGraphWithCommitsAndParents(cwd, graph, [sharedAncestryCommit]);
      pullRequestCleanupContexts.set(number, {
        aggregateBaseStateProofComputed: false,
        aggregatePaths: new Set(aggregatePaths),
        baseCommit: aggregateBaseCommit,
        headCommit: metadata.headCommit,
        members: pullRequestCommitSet,
        sharedAncestryCommit,
      });
      for (const candidateCommit of [...new Set([metadata.mergeCommit, ...pullRequestCommits])]) {
        const patch = commitFirstParentPatch(cwd, graph, candidateCommit);
        const record = graph.get(candidateCommit);
        if (!patch || !record) {
          continue;
        }
        const candidatePaths = changedPaths(cwd, patch.parent, candidateCommit);
        const candidate = {
          ...patch,
          commit: candidateCommit,
          kind: candidateCommit === metadata.mergeCommit ? "merge" : "pull-request",
          number,
          paths: candidatePaths,
          tree: record.tree,
        };
        addComparisonPatch(candidate);
        const treeProof =
          candidatePatchTreeProof(cwd, graph, sourceTarget, candidate) ??
          candidatePatchAmbiguityProof(cwd, graph, sourceTarget, candidate);
        if (treeProof && !candidateIsBranchLocalCleanup(candidate)) {
          const match = {
            candidateKind: `${candidate.kind}-final-tree`,
            ...treeProof,
          };
          const commonAncestrySurvivalProof = commonAncestrySurvivalProofFor(candidate);
          if (commonAncestrySurvivalProof) {
            addSuppressedCommonAncestryPatchMatch(number, {
              ...match,
              commonAncestrySurvivalProof,
            });
            continue;
          }
          const context = pullRequestCleanupContexts.get(number);
          const candidateIsInAggregate = candidate.paths.every((path) =>
            context.aggregatePaths.has(path),
          );
          const isAmbiguous = treeProof.proofStrength === "ambiguous-target-provenance";
          const aggregateProof = isAmbiguous ? aggregateBaseStateProofFor(number) : undefined;
          const isProvenAbsentAmbiguity =
            isAmbiguous &&
            candidateIsInAggregate &&
            aggregateProof?.sourceExclusivePathCommits.count === 0;
          if (isProvenAbsentAmbiguity) {
            addSuppressedAmbiguousPatchMatch(number, match);
          } else {
            addPatchMatch(number, match);
          }
        }
      }
      // GitHub retains the base/head OIDs associated with a merged PR even
      // after its refs are deleted. Resolve those snapshots, never moving main.
      const aggregatePatch = commitRangePatch(cwd, aggregateBaseCommit, metadata.headCommit);
      const headRecord = graph.get(metadata.headCommit);
      if (aggregatePatch && headRecord) {
        const aggregateCandidate = {
          ...aggregatePatch,
          commit: metadata.headCommit,
          kind: "pull-request-aggregate",
          number,
          paths: aggregatePaths,
          tree: headRecord.tree,
        };
        addComparisonPatch(aggregateCandidate);
        const treeProof =
          candidatePatchTreeProof(cwd, graph, sourceTarget, aggregateCandidate) ??
          candidatePatchAmbiguityProof(cwd, graph, sourceTarget, aggregateCandidate);
        if (treeProof) {
          const match = {
            candidateKind: "pull-request-aggregate-final-tree",
            ...treeProof,
          };
          const commonAncestrySurvivalProof = commonAncestrySurvivalProofFor(aggregateCandidate);
          if (commonAncestrySurvivalProof) {
            addSuppressedCommonAncestryPatchMatch(number, {
              ...match,
              commonAncestrySurvivalProof,
            });
            continue;
          }
          const isAmbiguous = treeProof.proofStrength === "ambiguous-target-provenance";
          const aggregateProof = isAmbiguous ? aggregateBaseStateProofFor(number) : undefined;
          if (isAmbiguous && aggregateProof?.sourceExclusivePathCommits.count === 0) {
            addSuppressedAmbiguousPatchMatch(number, match);
          } else {
            addPatchMatch(number, match);
          }
        }
      }
    }
    for (const commit of commits.filter(
      (entry) =>
        entry.parents.length === 1 &&
        (entry.disposition === "direct" ||
          entry.disposition === "pull-request" ||
          entry.disposition === "reverted"),
    )) {
      for (const candidate of comparisonPatches.get(commit.patchId) ?? []) {
        if (
          exactCandidatePatchEquivalent(cwd, graph, commit.commit, candidate) &&
          !candidateIsBranchLocalCleanup(candidate)
        ) {
          const match = {
            candidateBaseCommit: candidate.parent,
            candidateCommit: candidate.commit,
            candidateKind: candidate.kind,
            targetCommit: commit.commit,
          };
          const commonAncestrySurvivalProof = commonAncestrySurvivalProofFor(candidate);
          if (commonAncestrySurvivalProof) {
            addSuppressedCommonAncestryPatchMatch(candidate.number, {
              ...match,
              commonAncestrySurvivalProof,
            });
          } else {
            addPatchMatch(candidate.number, match);
          }
        }
      }
    }
    for (const overlapEntry of trustedComparisonPullRequestMemberOverlaps) {
      const label =
        `trusted comparison member overlap #${overlapEntry.number}:` +
        `${overlapEntry.sourceCommit}:${overlapEntry.targetCommit}:${overlapEntry.witnessCommit}`;
      const metadata = searchMetadata.get(overlapEntry.number);
      const pullRequestCommits = postForkCommitLists.get(overlapEntry.number);
      const candidates = comparisonCandidatesByPullRequest.get(overlapEntry.number) ?? [];
      const sourceCandidate = candidates.find(
        (candidate) =>
          candidate.kind === "pull-request" && candidate.commit === overlapEntry.sourceCommit,
      );
      const aggregateCandidate = candidates.find(
        (candidate) => candidate.kind === "pull-request-aggregate",
      );
      const targetCommit = commits.find((commit) => commit.commit === overlapEntry.targetCommit);
      const sourceRecord = graph.get(overlapEntry.sourceCommit);
      const targetRecord = graph.get(overlapEntry.targetCommit);
      const witnessRecord = graph.get(overlapEntry.witnessCommit);
      const mergeRecord = graph.get(metadata?.mergeCommit);
      const mergeParent = mergeRecord?.parents[0];
      const targetPatch = commitFirstParentPatch(cwd, graph, overlapEntry.targetCommit);
      const witnessPatch = commitFirstParentPatch(cwd, graph, overlapEntry.witnessCommit);
      const targetPaths =
        targetRecord?.parents.length === 1
          ? changedPaths(cwd, targetRecord.parents[0], overlapEntry.targetCommit)
          : [];
      const witnessPaths =
        witnessRecord?.parents.length === 1
          ? changedPaths(cwd, witnessRecord.parents[0], overlapEntry.witnessCommit)
          : [];
      const sourceAssociations = allAssociations.get(overlapEntry.sourceCommit) ?? [];
      const targetAssociations = allAssociations.get(overlapEntry.targetCommit) ?? [];
      const witnessAssociations = allAssociations.get(overlapEntry.witnessCommit) ?? [];
      const pullRequestMemberRelations = (pullRequestCommits ?? []).map((commit) => ({
        commit,
        memberAncestorOfTarget: isAncestor(cwd, commit, overlapEntry.targetCommit),
        memberAncestorOfWitness: isAncestor(cwd, commit, overlapEntry.witnessCommit),
        targetAncestorOfMember: isAncestor(cwd, overlapEntry.targetCommit, commit),
        witnessAncestorOfMember: isAncestor(cwd, overlapEntry.witnessCommit, commit),
      }));
      const topology =
        metadata && mergeParent
          ? {
              baseAncestorOfMergeParent: isAncestor(cwd, metadata.baseCommit, mergeParent),
              sourceAncestorOfHead: isAncestor(cwd, overlapEntry.sourceCommit, metadata.headCommit),
              sourceAncestorOfMerge: isAncestor(
                cwd,
                overlapEntry.sourceCommit,
                metadata.mergeCommit,
              ),
              sourceAncestorOfMergeParent: isAncestor(cwd, overlapEntry.sourceCommit, mergeParent),
              sourceAncestorOfTarget: isAncestor(
                cwd,
                overlapEntry.sourceCommit,
                overlapEntry.targetCommit,
              ),
              sourceAncestorOfWitness: isAncestor(
                cwd,
                overlapEntry.sourceCommit,
                overlapEntry.witnessCommit,
              ),
              targetAncestorOfHead: isAncestor(cwd, overlapEntry.targetCommit, metadata.headCommit),
              targetAncestorOfMerge: isAncestor(
                cwd,
                overlapEntry.targetCommit,
                metadata.mergeCommit,
              ),
              targetAncestorOfMergeParent: isAncestor(cwd, overlapEntry.targetCommit, mergeParent),
              targetAncestorOfSource: isAncestor(
                cwd,
                overlapEntry.targetCommit,
                overlapEntry.sourceCommit,
              ),
              targetAncestorOfWitness: isAncestor(
                cwd,
                overlapEntry.targetCommit,
                overlapEntry.witnessCommit,
              ),
              witnessAncestorOfHead: isAncestor(
                cwd,
                overlapEntry.witnessCommit,
                metadata.headCommit,
              ),
              witnessAncestorOfMergeParent: isAncestor(
                cwd,
                overlapEntry.witnessCommit,
                mergeParent,
              ),
              witnessAncestorOfSource: isAncestor(
                cwd,
                overlapEntry.witnessCommit,
                overlapEntry.sourceCommit,
              ),
              witnessAncestorOfTarget: isAncestor(
                cwd,
                overlapEntry.witnessCommit,
                overlapEntry.targetCommit,
              ),
            }
          : undefined;
      if (
        !metadata ||
        !pullRequestCommits ||
        !pullRequestCommits.includes(overlapEntry.sourceCommit) ||
        !pullRequestCommits.includes(metadata.headCommit) ||
        pullRequestCommits.includes(overlapEntry.targetCommit) ||
        pullRequestCommits.includes(overlapEntry.witnessCommit) ||
        pullRequestMemberRelations.some(
          (relation) =>
            relation.memberAncestorOfTarget ||
            relation.memberAncestorOfWitness ||
            relation.targetAncestorOfMember ||
            relation.witnessAncestorOfMember,
        ) ||
        !sourceCandidate ||
        !aggregateCandidate ||
        candidateIsBranchLocalCleanup(sourceCandidate) ||
        sourceRecord?.parents.length !== 1 ||
        !targetRecord ||
        targetRecord.parents.length !== 1 ||
        !witnessRecord ||
        witnessRecord.parents.length !== 1 ||
        mergeRecord?.parents.length !== 1 ||
        !mergeParent ||
        sourceRecord.author.timestamp >= targetRecord.author.timestamp ||
        sourceRecord.committer.timestamp >= targetRecord.committer.timestamp ||
        targetRecord.committer.timestamp >= Date.parse(metadata.mergedAt) ||
        Date.parse(metadata.mergedAt) > targetTimestamp ||
        sourceAncestors.has(overlapEntry.sourceCommit) ||
        sourceAncestors.has(overlapEntry.witnessCommit) ||
        !topology?.baseAncestorOfMergeParent ||
        !topology?.sourceAncestorOfHead ||
        topology.sourceAncestorOfMerge ||
        topology.sourceAncestorOfMergeParent ||
        topology.sourceAncestorOfTarget ||
        topology.sourceAncestorOfWitness ||
        topology.targetAncestorOfHead ||
        topology.targetAncestorOfMerge ||
        topology.targetAncestorOfMergeParent ||
        topology.targetAncestorOfSource ||
        topology.targetAncestorOfWitness ||
        topology.witnessAncestorOfHead ||
        !topology.witnessAncestorOfMergeParent ||
        topology.witnessAncestorOfSource ||
        topology.witnessAncestorOfTarget ||
        JSON.stringify(sourceAssociations) !== JSON.stringify([overlapEntry.number]) ||
        targetAssociations.length > 0 ||
        witnessAssociations.length > 0 ||
        !targetPatch ||
        !witnessPatch ||
        sourceCandidate.diffSha256 === targetPatch.diffSha256 ||
        targetPatch.diffSha256 !== witnessPatch.diffSha256 ||
        targetPatch.patch !== witnessPatch.patch ||
        targetPatch.patchId !== witnessPatch.patchId ||
        JSON.stringify(targetPaths) !== JSON.stringify(witnessPaths) ||
        JSON.stringify(targetRecord.author) !== JSON.stringify(witnessRecord.author) ||
        targetRecord.message !== witnessRecord.message ||
        witnessRecord.committer.timestamp >= targetRecord.committer.timestamp ||
        witnessRecord.committer.name !== targetRecord.committer.name ||
        witnessRecord.committer.email !== targetRecord.committer.email ||
        explicitPullRequestReferences(witnessRecord.subject, witnessRecord.body).length > 0 ||
        localReferencesIn(witnessRecord.message).length > 0 ||
        cherryPickOrigins(witnessRecord.body).length > 0 ||
        adaptationOrigins(witnessRecord.body).length > 0 ||
        revertedCommits(witnessRecord.message).length > 0 ||
        targetCommit?.disposition !== "direct" ||
        targetCommit.pullRequests.length > 0 ||
        targetCommit.evidence.length > 0 ||
        targetCommit.associatedPullRequests.length > 0 ||
        targetCommit.explicitPullRequestReferences.length > 0 ||
        targetCommit.references.length > 0 ||
        targetCommit.cherryPickOrigins.length > 0 ||
        targetCommit.adaptationOrigins.length > 0 ||
        targetCommit.verifiedCherryPickOrigins.length > 0 ||
        targetCommit.nonEquivalentCherryPickOrigins.length > 0 ||
        sourceCandidate.paths.length === 0 ||
        sourceCandidate.paths.length >= aggregateCandidate.paths.length ||
        JSON.stringify(sourceCandidate.paths) !== JSON.stringify(targetPaths) ||
        !sourceCandidate.paths.every((path) => aggregateCandidate.paths.includes(path)) ||
        !exactCandidatePatchEquivalent(cwd, graph, overlapEntry.targetCommit, sourceCandidate) ||
        !exactPatchEquivalent(cwd, graph, overlapEntry.targetCommit, overlapEntry.witnessCommit)
      ) {
        fail(`${label} is not an isolated direct exact-member overlap`);
      }
      const sourceZeroContextPatch = normalizedZeroContextPatch(
        candidateZeroContextPatch(cwd, sourceCandidate),
      );
      const targetZeroContextPatch = normalizedZeroContextPatch(
        zeroContextPatch(cwd, targetRecord.parents[0], overlapEntry.targetCommit, targetPaths),
      );
      if (sourceZeroContextPatch === "" || sourceZeroContextPatch !== targetZeroContextPatch) {
        fail(`${label} does not have identical normalized zero-context bytes`);
      }
      const allMainPathHistoryOutput = git(cwd, [
        "rev-list",
        "--full-history",
        mergeParent,
        "--",
        ...targetPaths,
      ]).trim();
      const allMainPathHistory =
        allMainPathHistoryOutput === "" ? [] : allMainPathHistoryOutput.split("\n");
      const firstParentPathHistoryOutput = git(cwd, [
        "rev-list",
        "--first-parent",
        "--full-history",
        mergeParent,
        "--",
        ...targetPaths,
      ]).trim();
      const firstParentPathHistory =
        firstParentPathHistoryOutput === "" ? [] : firstParentPathHistoryOutput.split("\n");
      extendGraphWithCommitsAndParents(cwd, graph, allMainPathHistory);
      const targetPathPatches = new Map(
        targetPaths.map((path) => [
          path,
          commitPathPatch(cwd, graph, overlapEntry.targetCommit, path),
        ]),
      );
      const independentWitnesses = allMainPathHistory
        .filter((commit) => {
          const record = graph.get(commit);
          if (record?.parents.length !== 1) {
            return false;
          }
          return targetPaths.every((path) => {
            const patch = commitPathPatch(cwd, graph, commit, path);
            const targetPathPatch = targetPathPatches.get(path);
            return (
              patch &&
              targetPathPatch &&
              patch.diffSha256 === targetPathPatch.diffSha256 &&
              patch.patch === targetPathPatch.patch &&
              patch.patchId === targetPathPatch.patchId
            );
          });
        })
        .toSorted();
      if (
        independentWitnesses.length !== 1 ||
        independentWitnesses[0] !== overlapEntry.witnessCommit ||
        !firstParentPathHistory.includes(overlapEntry.witnessCommit)
      ) {
        fail(`${label} does not have exactly one independent main witness`);
      }
      const witnessSurvivalOutput = git(cwd, [
        "rev-list",
        "--first-parent",
        "--reverse",
        `${overlapEntry.witnessCommit}..${mergeParent}`,
        "--",
        ...targetPaths,
      ]).trim();
      const witnessSurvivalCommits = [
        overlapEntry.witnessCommit,
        ...(witnessSurvivalOutput === "" ? [] : witnessSurvivalOutput.split("\n")),
      ];
      const witnessSurvivalStates = witnessSurvivalCommits.flatMap((commit) =>
        targetPaths.map((path) => ({
          commit,
          path,
          stateSha256: pathStateSha256(cwd, commit, path),
          targetStateSha256: pathStateSha256(cwd, overlapEntry.targetCommit, path),
        })),
      );
      if (witnessSurvivalStates.some((state) => state.stateSha256 !== state.targetStateSha256)) {
        fail(`${label} does not preserve the main witness on its first-parent path`);
      }
      const exactMemberCandidates = candidates.filter(
        (candidate) =>
          candidate.kind === "pull-request" &&
          !candidateIsBranchLocalCleanup(candidate) &&
          exactCandidatePatchEquivalent(cwd, graph, overlapEntry.targetCommit, candidate),
      );
      if (
        exactMemberCandidates.length !== 1 ||
        exactMemberCandidates[0].commit !== overlapEntry.sourceCommit
      ) {
        fail(`${label} does not select exactly one non-cleanup pull request member`);
      }
      const cleanupContext = pullRequestCleanupContexts.get(overlapEntry.number);
      const branchLocalCleanupCandidates = candidates
        .filter((candidate) => candidateIsBranchLocalCleanup(candidate))
        .map((candidate) => {
          const proofPatch = candidateZeroContextPatch(cwd, candidate);
          return {
            baseCommit: cleanupContext.baseCommit,
            baseTree: graph.get(cleanupContext.baseCommit).tree,
            commit: candidate.commit,
            diffSha256: candidate.diffSha256,
            headCommit: cleanupContext.headCommit,
            headTree: graph.get(cleanupContext.headCommit).tree,
            kind: candidate.kind,
            parent: candidate.parent,
            patchId: candidate.patchId,
            paths: setSummary(candidate.paths),
            proofMethod: "zero-context-round-trip-on-pr-base-and-head",
            proofPatchSha256: createHash("sha256").update(proofPatch).digest("hex"),
            tree: candidate.tree,
          };
        });
      const sourceHeadProof = candidateExactPathTreeProof(
        cwd,
        graph,
        metadata.headCommit,
        sourceCandidate,
      );
      const mergeParentProof = candidateExactPathTreeProof(
        cwd,
        graph,
        mergeParent,
        sourceCandidate,
      );
      const mergeCommitProof = candidateExactPathTreeProof(
        cwd,
        graph,
        metadata.mergeCommit,
        sourceCandidate,
      );
      const aggregateTargetProof =
        candidatePatchTreeProof(cwd, graph, sourceTarget, aggregateCandidate) ??
        candidatePatchAmbiguityProof(cwd, graph, sourceTarget, aggregateCandidate);
      if (!sourceHeadProof || !mergeParentProof || !mergeCommitProof || aggregateTargetProof) {
        fail(`${label} does not prove immutable member survival and aggregate omission`);
      }
      const candidateChangedLineHashes = changedLineHashes(sourceZeroContextPatch);
      const mergeFirstParentZeroContextPatch = zeroContextPatch(
        cwd,
        mergeParent,
        metadata.mergeCommit,
        sourceCandidate.paths,
      );
      const mergeChangedLineHashes = changedLineHashes(mergeFirstParentZeroContextPatch);
      const mergeAllocatedCandidateLines = candidateChangedLineHashes.filter((hash) =>
        mergeChangedLineHashes.includes(hash),
      );
      if (candidateChangedLineHashes.length === 0 || mergeAllocatedCandidateLines.length > 0) {
        fail(`${label} member hunk is allocated by the pull request merge`);
      }
      const overlapPathSet = new Set(sourceCandidate.paths);
      const basePathEvidence = [];
      const overlapPathEvidence = [];
      for (const path of aggregateCandidate.paths) {
        const baseStateSha256 = pathStateSha256(cwd, aggregateCandidate.parent, path);
        const headStateSha256 = pathStateSha256(cwd, metadata.headCommit, path);
        const targetStateSha256 = pathStateSha256(cwd, sourceTarget, path);
        if (baseStateSha256 === headStateSha256) {
          fail(`${label} aggregate path ${path} has no immutable head change`);
        }
        if (!overlapPathSet.has(path)) {
          if (targetStateSha256 !== baseStateSha256) {
            fail(`${label} source target does not retain aggregate base state for ${path}`);
          }
          basePathEvidence.push({
            baseStateSha256,
            headStateSha256,
            path,
            targetStateSha256,
          });
          continue;
        }
        const targetCommitStateSha256 = pathStateSha256(cwd, overlapEntry.targetCommit, path);
        const witnessCommitStateSha256 = pathStateSha256(cwd, overlapEntry.witnessCommit, path);
        const mergeParentStateSha256 = pathStateSha256(cwd, mergeParent, path);
        if (
          targetStateSha256 !== targetCommitStateSha256 ||
          targetCommitStateSha256 !== witnessCommitStateSha256 ||
          targetCommitStateSha256 !== mergeParentStateSha256 ||
          targetStateSha256 === baseStateSha256 ||
          targetStateSha256 === headStateSha256
        ) {
          fail(`${label} overlap path ${path} is not isolated from the pull request head`);
        }
        const exactPathEvidence = exactPathPatchEvidence(
          cwd,
          graph,
          overlapEntry.sourceCommit,
          overlapEntry.targetCommit,
          path,
        );
        if (!exactPathEvidence) {
          fail(`${label} overlap path ${path} lacks bidirectional exact patch evidence`);
        }
        const hunkAnchorEvidence = candidateHunkAnchorEvidence(
          cwd,
          graph,
          aggregateCandidate.parent,
          sourceCandidate,
          overlapEntry.targetCommit,
          path,
        );
        if (!hunkAnchorEvidence) {
          fail(`${label} overlap path ${path} lacks a unique immutable hunk anchor`);
        }
        overlapPathEvidence.push({
          ...exactPathEvidence,
          baseStateSha256,
          headStateSha256,
          hunkAnchor: hunkAnchorEvidence,
          mergeParentStateSha256,
          targetCommitStateSha256,
          targetStateSha256,
          witnessCommitStateSha256,
        });
      }
      const sourceExclusiveOutput = git(cwd, [
        "rev-list",
        "--full-history",
        sourceTarget,
        `^${aggregateCandidate.parent}`,
        "--",
        ...aggregateCandidate.paths,
      ]).trim();
      const sourceExclusivePathCommits = setSummary(
        sourceExclusiveOutput === "" ? [] : sourceExclusiveOutput.split("\n"),
      );
      if (
        JSON.stringify(sourceExclusivePathCommits.members) !==
        JSON.stringify([overlapEntry.targetCommit])
      ) {
        fail(`${label} has additional source-side commits on pull request aggregate paths`);
      }
      const patchMatches = patchMatchesByPullRequest.get(overlapEntry.number) ?? [];
      const exactTupleMatches = patchMatches.filter(
        (match) =>
          match.candidateCommit === overlapEntry.sourceCommit &&
          match.candidateKind === "pull-request" &&
          match.targetCommit === overlapEntry.targetCommit,
      );
      const finalTreeTupleMatches = patchMatches.filter(
        (match) =>
          match.candidateCommit === overlapEntry.sourceCommit &&
          match.candidateKind === "pull-request-final-tree" &&
          match.targetCommit === sourceTarget,
      );
      if (exactTupleMatches.length !== 1 || finalTreeTupleMatches.length !== 1) {
        fail(`${label} does not bind exactly one scanner commit match and final-tree match`);
      }
      const explainedMatches = new Set([...exactTupleMatches, ...finalTreeTupleMatches]);
      patchMatchesByPullRequest.set(
        overlapEntry.number,
        patchMatches.filter((match) => !explainedMatches.has(match)),
      );
      const normalizedZeroContextSha256 = createHash("sha256")
        .update(sourceZeroContextPatch)
        .digest("hex");
      const evidence = {
        aggregate: {
          baseCommit: aggregateCandidate.parent,
          basePaths: recordSummary(basePathEvidence),
          baseTree: graph.get(aggregateCandidate.parent).tree,
          diffSha256: aggregateCandidate.diffSha256,
          headCommit: metadata.headCommit,
          headTree: graph.get(metadata.headCommit).tree,
          overlapPaths: recordSummary(overlapPathEvidence),
          patchId: aggregateCandidate.patchId,
          paths: setSummary(aggregateCandidate.paths),
          sourceExclusivePathCommits,
          targetTreeProof: null,
        },
        method: "reviewed-nonownership-exact-member-overlap",
        normalizedZeroContextSha256,
        ownershipAttributed: false,
        branchLocalCleanupCandidates: recordSummary(branchLocalCleanupCandidates),
        pullRequest: metadata,
        pullRequestMembers: setSummary(pullRequestCommits),
        source: {
          associations: setSummary(sourceAssociations, (left, right) => left - right),
          author: sourceRecord.author,
          commit: overlapEntry.sourceCommit,
          committer: sourceRecord.committer,
          diffSha256: sourceCandidate.diffSha256,
          messageSha256: createHash("sha256").update(sourceRecord.message).digest("hex"),
          parent: sourceCandidate.parent,
          parentTree: graph.get(sourceCandidate.parent).tree,
          patchId: sourceCandidate.patchId,
          paths: setSummary(sourceCandidate.paths),
          tree: sourceCandidate.tree,
        },
        target: {
          adaptationOrigins: setSummary(targetCommit.adaptationOrigins),
          associations: setSummary(targetAssociations, (left, right) => left - right),
          author: targetRecord.author,
          cherryPickOrigins: setSummary(targetCommit.cherryPickOrigins),
          commit: overlapEntry.targetCommit,
          committer: targetRecord.committer,
          diffSha256: targetCommit.diffSha256,
          explicitPullRequestReferences: setSummary(
            targetCommit.explicitPullRequestReferences,
            (left, right) => left - right,
          ),
          messageSha256: createHash("sha256").update(targetRecord.message).digest("hex"),
          parent: targetRecord.parents[0],
          parentTree: graph.get(targetRecord.parents[0]).tree,
          patchId: targetCommit.patchId,
          paths: setSummary(targetPaths),
          references: setSummary(targetCommit.references, (left, right) => left - right),
          tree: targetRecord.tree,
        },
        merge: {
          candidateChangedLineHashes: setSummary(candidateChangedLineHashes),
          commit: metadata.mergeCommit,
          commitPresenceProof: mergeCommitProof,
          diffSha256: commitFirstParentPatch(cwd, graph, metadata.mergeCommit)?.diffSha256,
          firstParentChangedLineHashes: setSummary(mergeChangedLineHashes),
          firstParentCandidateLineOverlap: setSummary(mergeAllocatedCandidateLines),
          parent: mergeParent,
          parentPresenceProof: mergeParentProof,
          parentTree: graph.get(mergeParent).tree,
          tree: mergeRecord.tree,
        },
        scannerMatches: recordSummary([...exactTupleMatches, ...finalTreeTupleMatches]),
        sourceHeadProof,
        topology: {
          ...topology,
          pullRequestMemberRelations: recordSummary(pullRequestMemberRelations),
          pullRequestMergedAtTimestamp: Date.parse(metadata.mergedAt),
          sourceCutoffTimestamp: targetTimestamp,
        },
        witness: {
          adaptationOrigins: setSummary(adaptationOrigins(witnessRecord.body)),
          associations: setSummary(witnessAssociations, (left, right) => left - right),
          author: witnessRecord.author,
          cherryPickOrigins: setSummary(cherryPickOrigins(witnessRecord.body)),
          commit: overlapEntry.witnessCommit,
          committer: witnessRecord.committer,
          diffSha256: witnessPatch.diffSha256,
          explicitPullRequestReferences: setSummary(
            explicitPullRequestReferences(witnessRecord.subject, witnessRecord.body),
            (left, right) => left - right,
          ),
          allAncestryPathHistory: setSummary(allMainPathHistory),
          firstParentPathHistory: setSummary(firstParentPathHistory),
          firstParentSurvivalStates: recordSummary(witnessSurvivalStates),
          localReferences: setSummary(localReferencesIn(witnessRecord.message)),
          fullAncestryExactPathMatches: setSummary(independentWitnesses),
          messageSha256: createHash("sha256").update(witnessRecord.message).digest("hex"),
          parent: witnessRecord.parents[0],
          parentTree: graph.get(witnessRecord.parents[0]).tree,
          patchId: witnessPatch.patchId,
          paths: setSummary(witnessPaths),
          revertedCommits: setSummary(revertedCommits(witnessRecord.message)),
          tree: witnessRecord.tree,
        },
      };
      comparisonPullRequestMemberOverlapEvidence.set(overlapEntry.number, evidence);
    }
    if (
      comparisonPullRequestMemberOverlapEvidence.size !==
      trustedComparisonPullRequestMemberOverlaps.length
    ) {
      fail("trusted comparison member overlap evidence is incomplete");
    }
    const postForkEvidence = postForkNotBackported.map((number) => {
      const metadata = searchMetadata.get(number);
      const pullRequestCommits = postForkCommitLists.get(number);
      const pullRequestCommitSet = new Set(pullRequestCommits);
      const canonicalCommits = commits
        .filter(
          (commit) =>
            commit.pullRequests.includes(number) ||
            commit.associatedPullRequests.includes(number) ||
            commit.evidence.some((entry) => entry.number === number) ||
            commit.explicitPullRequestReferences.includes(number),
        )
        .map((commit) => commit.commit)
        .toSorted();
      const contextualReferences = commits
        .filter(
          (commit) =>
            commit.references.includes(number) &&
            !commit.explicitPullRequestReferences.includes(number),
        )
        .map((commit) => commit.commit)
        .toSorted();
      const cherryPickCommits = commits
        .filter((commit) =>
          [...commit.cherryPickOrigins, ...commit.adaptationOrigins].some((origin) =>
            pullRequestCommitSet.has(origin),
          ),
        )
        .map((commit) => commit.commit)
        .toSorted();
      const ancestralCommits = [metadata.mergeCommit, metadata.headCommit, ...pullRequestCommits]
        .filter((commit) => sourceAncestors.has(commit))
        .toSorted();
      const patchEquivalentCommits = (patchMatchesByPullRequest.get(number) ?? []).toSorted(
        (left, right) =>
          left.targetCommit.localeCompare(right.targetCommit) ||
          left.candidateCommit.localeCompare(right.candidateCommit),
      );
      const suppressedAmbiguousPatchMatches = (
        suppressedAmbiguousPatchMatchesByPullRequest.get(number) ?? []
      ).toSorted(
        (left, right) =>
          left.targetCommit.localeCompare(right.targetCommit) ||
          left.candidateCommit.localeCompare(right.candidateCommit),
      );
      const suppressedCommonAncestryPatchMatches = (
        suppressedCommonAncestryPatchMatchesByPullRequest.get(number) ?? []
      ).toSorted(
        (left, right) =>
          left.targetCommit.localeCompare(right.targetCommit) ||
          left.candidateCommit.localeCompare(right.candidateCommit),
      );
      const context = pullRequestCleanupContexts.get(number);
      const reviewedMemberOverlap = comparisonPullRequestMemberOverlapEvidence.get(number);
      if (
        canonicalCommits.length > 0 ||
        cherryPickCommits.length > 0 ||
        ancestralCommits.length > 0 ||
        patchEquivalentCommits.length > 0
      ) {
        fail(`comparison-only pull request #${number} has target provenance`);
      }
      return {
        ...(context.aggregateBaseStateProof
          ? { aggregateBaseStateProof: context.aggregateBaseStateProof }
          : {}),
        ancestralCommits,
        baseBranch: metadata.baseBranch,
        baseCommit: metadata.baseCommit,
        canonicalCommits,
        cherryPickCommits,
        contextualReferences,
        headCommit: metadata.headCommit,
        mergeCommit: metadata.mergeCommit,
        mergedAt: metadata.mergedAt,
        patchEquivalentCommits,
        pullRequest: number,
        pullRequestCommits,
        ...(reviewedMemberOverlap ? { reviewedMemberOverlap } : {}),
        ...(suppressedAmbiguousPatchMatches.length > 0 ? { suppressedAmbiguousPatchMatches } : {}),
        ...(suppressedCommonAncestryPatchMatches.length > 0
          ? { suppressedCommonAncestryPatchMatches }
          : {}),
      };
    });
    const associatedBoundarySet = new Set(associatedBoundary);
    const boundaryEvidence = boundary.map((number) => {
      const metadata = searchMetadata.get(number);
      return associatedBoundarySet.has(number)
        ? {
            mergeCommit: mergeBase,
            method: "merge-base-association",
            pullRequest: number,
          }
        : {
            mergeBase,
            mergeCommit: metadata.mergeCommit,
            mergedAt: metadata.mergedAt,
            method: "same-second-ancestral-merge",
            pullRequest: number,
            windowStartTimestamp: comparisonUniverse.window.startTimestamp,
          };
    });
    const shippedEvidence = shipped.map((number) => {
      const targetCommits = commits
        .filter(
          (commit) => commit.disposition === "shipped" && commit.pullRequests.includes(number),
        )
        .map((commit) => ({
          commit: commit.commit,
          shippedEvidence: commit.shippedEvidence,
        }))
        .toSorted((left, right) => left.commit.localeCompare(right.commit));
      if (targetCommits.length === 0) {
        fail(`shipped comparison pull request #${number} has no exact target evidence`);
      }
      return { pullRequest: number, targetCommits };
    });
    const netRevertedEvidence = netReverted.map((number) => {
      const targetCommits = commits
        .filter(
          (commit) => commit.disposition === "reverted" && commit.pullRequests.includes(number),
        )
        .map((commit) => commit.commit)
        .toSorted();
      const targetSet = new Set(targetCommits);
      const edges = revertEdges
        .filter((edge) => targetSet.has(edge.targetCommit) && active.has(edge.revertCommit))
        .toSorted(
          (left, right) =>
            left.targetCommit.localeCompare(right.targetCommit) ||
            left.revertCommit.localeCompare(right.revertCommit),
        );
      if (
        targetCommits.length === 0 ||
        !targetCommits.every((commit) => edges.some((edge) => edge.targetCommit === commit))
      ) {
        fail(`net-reverted comparison pull request #${number} lacks verified revert evidence`);
      }
      return { pullRequest: number, revertEdges: edges, targetCommits };
    });
    const partitionsByName = {
      netReverted: setSummary(netReverted, (left, right) => left - right),
      postForkNotBackported: setSummary(postForkNotBackported, (left, right) => left - right),
      shippedOrBoundary: setSummary([...boundary, ...shipped], (left, right) => left - right),
    };
    const memberships = new Map();
    for (const [name, partition] of Object.entries({
      canonical: [...canonical],
      netReverted,
      postForkNotBackported,
      shippedOrBoundary: [...boundary, ...shipped],
    })) {
      for (const number of partition) {
        const names = memberships.get(number) ?? [];
        names.push(name);
        memberships.set(number, names);
      }
    }
    const missing = [...universe]
      .filter((number) => !memberships.has(number))
      .toSorted((left, right) => left - right);
    const overlaps = [...memberships]
      .filter(([, names]) => names.length > 1)
      .map(([number, names]) => ({ names: names.toSorted(), number }))
      .toSorted((left, right) => left.number - right.number);
    const unexpected = [...memberships.keys()]
      .filter((number) => !universe.has(number))
      .toSorted((left, right) => left - right);
    if (missing.length > 0 || overlaps.length > 0 || unexpected.length > 0) {
      fail("merged pull request comparison partitions are not disjoint and exhaustive");
    }
    const excludedCount = Object.values(partitionsByName).reduce(
      (total, entry) => total + entry.count,
      0,
    );
    if (excludedCount !== comparisonOnly.size) {
      fail(
        `merged pull request comparison partition covers ${excludedCount} of ${comparisonOnly.size} exclusions`,
      );
    }
    comparison = {
      baseBranch: comparisonUniverse.baseBranch,
      canonical: setSummary(canonical, (left, right) => left - right),
      canonicalOnly: setSummary(canonicalOnly, (left, right) => left - right),
      comparisonOnly: setSummary(comparisonOnly, (left, right) => left - right),
      equation: `${universe.size} - ${partitionsByName.postForkNotBackported.count} post-fork PRs not backported - ${partitionsByName.shippedOrBoundary.count} shipped/boundary PRs - ${partitionsByName.netReverted.count} net-reverted PRs = ${canonical.size}`,
      overlap: setSummary(overlap, (left, right) => left - right),
      partitionAudit: {
        excludedCount,
        missing,
        overlaps,
        universeCoveredCount: memberships.size,
        unexpected,
      },
      partitionEvidence: {
        boundary: recordSummary(boundaryEvidence),
        netReverted: recordSummary(netRevertedEvidence),
        postFork: recordSummary(postForkEvidence),
        shipped: recordSummary(shippedEvidence),
      },
      partitions: partitionsByName,
      query: comparisonUniverse.query,
      records: orderedRecordSummary(
        comparisonUniverse.records,
        (left, right) => left.number - right.number,
      ),
      repository: comparisonUniverse.repository,
      searchRecordsSha256: comparisonUniverse.recordsSha256,
      searchUniverse: setSummary(searchUniverse, (left, right) => left - right),
      segments: comparisonUniverse.segments,
      targetAssociatedOutsideSearch: recordSummary(targetAssociatedOutsideSearch),
      unclassified: setSummary([], (left, right) => left - right),
      universe: setSummary(universe, (left, right) => left - right),
      window: comparisonUniverse.window,
    };
  }
  const inventory = {
    associationSnapshots,
    comparison,
    complete: unresolved.length === 0,
    commits,
    partitions,
    pullRequestSnapshots,
    range: {
      base: { commit: base, ref: baseRef },
      finalTarget,
      finalTargetTimestamp,
      mergeBase,
      mergeBaseTimestamp: graph.get(mergeBase).committer.timestamp,
      provenance,
      ...(trustedComparisonPullRequestMemberOverlaps.length > 0
        ? {
            comparisonPullRequestMemberOverlaps: trustedComparisonPullRequestMemberOverlaps.map(
              (entry) => ({
                details: comparisonPullRequestMemberOverlapEvidence.get(entry.number),
                number: entry.number,
                sourceCommit: entry.sourceCommit,
                sourceRef: entry.sourceRef,
                targetCommit: entry.targetCommit,
                targetRef: entry.targetRef,
                witnessCommit: entry.witnessCommit,
                witnessRef: entry.witnessRef,
              }),
            ),
          }
        : {}),
      provenanceAdaptedPullRequests: trustedAdaptedPullRequestProvenance.map((entry) => ({
        details: trustedAdaptedPullRequestDetails.get(entry.targetCommit),
        number: entry.number,
        originCommit: entry.originCommit,
        originRef: entry.originRef,
        targetCommit: entry.targetCommit,
        targetRef: entry.targetRef,
      })),
      ...(trustedIntegratedPullRequestProvenance.length > 0
        ? {
            provenanceIntegratedPullRequests: trustedIntegratedPullRequestProvenance.map(
              (entry) => ({
                details: trustedIntegratedPullRequestDetails.get(entry.targetCommit),
                number: entry.number,
                sources: entry.sources,
                targetCommit: entry.targetCommit,
                targetRef: entry.targetRef,
              }),
            ),
          }
        : {}),
      provenancePartialPullRequests: trustedPartialPullRequestProvenance.map((entry) => ({
        details: trustedPartialPullRequestDetails.get(entry.targetCommit),
        number: entry.number,
        sourceCommit: entry.sourceCommit,
        sourceRef: entry.sourceRef,
        targetCommit: entry.targetCommit,
        targetRef: entry.targetRef,
      })),
      provenancePullRequests: trustedPullRequestProvenance.map((entry) => ({
        commit: entry.commit,
        details: sourceRecords
          .map((record) => trustedPullRequestDetails.get(record.commit))
          .filter((details) => details?.number === entry.number),
        matchedCommits: sourceRecords
          .filter((record) =>
            (trustedPullRequestEvidence.get(record.commit) ?? []).some(
              (evidence) =>
                evidence.number === entry.number && evidence.sourceCommit === entry.commit,
            ),
          )
          .map((record) => record.commit),
        number: entry.number,
        ref: entry.ref,
      })),
      shipped: shippedHistoryByRef.map(({ commit, mergeBase: baselineMergeBase, ref }) => {
        const evidence = shippedBaselineEvidence.get(ref);
        return {
          ref,
          commit,
          mergeBase: baselineMergeBase,
          history: evidence.history,
          revertEdges: evidence.revertEdges,
          activeCommits: evidence.activeCommits,
        };
      }),
      sourceTarget,
      sourceTail,
      targetTimestamp,
    },
    referenceSnapshots,
    repository,
    schemaVersion: 4,
    unresolved: unresolved.toSorted(
      (left, right) =>
        left.commit.localeCompare(right.commit) || left.kind.localeCompare(right.kind),
    ),
  };
  return { ...inventory, sha256: digestInventory(inventory) };
}

export function assertCompleteReleaseSourceInventory(inventory) {
  if (!inventory?.complete || inventory.unresolved?.length > 0) {
    const reasons = (inventory?.unresolved ?? [])
      .map((entry) => `${entry.commit}: ${entry.reason}`)
      .join("\n");
    fail(`release source inventory is incomplete${reasons ? `:\n${reasons}` : ""}`);
  }
  return inventory;
}
