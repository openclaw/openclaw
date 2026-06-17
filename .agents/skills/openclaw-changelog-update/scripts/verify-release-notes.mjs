#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const repo = "openclaw/openclaw";
const excludedHandles = new Set(["openclaw", "clawsweeper", "codex", "steipete"]);

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    releaseTags: [],
    checkGithub: false,
    json: false,
    writeLedger: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check-github" || arg === "--json" || arg === "--write-ledger") {
      options[
        arg === "--check-github"
          ? "checkGithub"
          : arg === "--write-ledger"
            ? "writeLedger"
            : "json"
      ] = true;
      continue;
    }
    if (arg === "--base" || arg === "--target" || arg === "--version" || arg === "--release-tag") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        fail(`missing value for ${arg}`);
      }
      if (arg === "--release-tag") {
        options.releaseTags.push(value);
      } else {
        options[arg.slice(2)] = value;
      }
      index += 1;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }

  for (const name of ["base", "target", "version"]) {
    if (!options[name]) {
      fail(`--${name} is required`);
    }
  }
  if (options.checkGithub && options.releaseTags.length === 0) {
    fail("--check-github requires at least one --release-tag");
  }
  return options;
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function git(args) {
  return run("git", args).trimEnd();
}

function githubApi(args) {
  try {
    return JSON.parse(run("ghx", ["api", ...args]).replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, ""));
  } catch (error) {
    if (typeof error.stdout === "string" && error.stdout.trim() !== "") {
      return JSON.parse(error.stdout.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, ""));
    }
    throw error;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isEligibleHandle(handle) {
  return Boolean(handle) && !handle.endsWith("[bot]") && !excludedHandles.has(handle.toLowerCase());
}

function sectionFor(changelog, version) {
  const heading = new RegExp(`^## ${escapeRegExp(version)}\\r?$`, "m").exec(changelog);
  if (!heading || heading.index === undefined) {
    fail(`CHANGELOG.md does not contain ## ${version}`);
  }
  const start = heading.index;
  const bodyStart = changelog.indexOf("\n", start) + 1;
  const next = /^## /gm;
  next.lastIndex = bodyStart;
  const nextHeading = next.exec(changelog);
  const end = nextHeading?.index ?? changelog.length;
  return {
    start,
    end,
    source: changelog.slice(start, end).trimEnd(),
    body: changelog.slice(bodyStart, end).trim(),
  };
}

function referencesIn(text) {
  return [...text.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function appendReferences(references, additions) {
  const seen = new Set(references);
  for (const number of additions) {
    if (!seen.has(number)) {
      references.push(number);
      seen.add(number);
    }
  }
}

function sourceCommits(base, target) {
  const mergeBase = git(["merge-base", base, target]);
  const output = git([
    "log",
    "--first-parent",
    "--reverse",
    "--format=%H%x1f%s%x1f%B%x1e",
    `${mergeBase}..${target}`,
  ]);
  const commits = new Map();
  const revertsByTarget = new Map();
  for (const record of output.split("\x1e")) {
    if (!record) {
      continue;
    }
    const [rawHash, subject, ...bodyParts] = record.split("\x1f");
    const hash = rawHash.trim();
    const body = bodyParts.join("\x1f");
    const revertedHash = body.match(/This reverts commit ([0-9a-f]{7,40})\./i)?.[1];
    const isRevert = subject.startsWith('Revert "') || Boolean(revertedHash);
    commits.set(hash, { body, hash, isRevert, revertedHash, subject });
  }
  for (const commit of commits.values()) {
    if (!commit.revertedHash) {
      continue;
    }
    const targetHash = [...commits.keys()].find((candidate) => candidate.startsWith(commit.revertedHash));
    if (targetHash) {
      const reverts = revertsByTarget.get(targetHash) ?? [];
      reverts.push(commit.hash);
      revertsByTarget.set(targetHash, reverts);
    }
  }
  const active = new Map();
  function isActive(hash) {
    if (active.has(hash)) {
      return active.get(hash);
    }
    const cancellingReverts = revertsByTarget.get(hash) ?? [];
    const value = !cancellingReverts.some((revertHash) => isActive(revertHash));
    active.set(hash, value);
    return value;
  }

  const references = [];
  const revertedReferences = new Set();
  const coauthorsByReference = new Map();
  for (const commit of commits.values()) {
    if (commit.isRevert) {
      continue;
    }
    const uniqueReferences = [...new Set(referencesIn(`${commit.subject}\n${commit.body}`))];
    if (!isActive(commit.hash)) {
      for (const number of uniqueReferences) {
        revertedReferences.add(number);
      }
      continue;
    }
    appendReferences(references, uniqueReferences);
    const coauthors = [...commit.body.matchAll(/<(?:(?:\d+)\+)?([^@<>\s]+)@users\.noreply\.github\.com>/gi)]
      .map((match) => match[1])
      .filter(isEligibleHandle);
    for (const number of uniqueReferences) {
      if (coauthors.length > 0) {
        const handles = coauthorsByReference.get(number) ?? new Set();
        for (const handle of coauthors) {
          handles.add(handle);
        }
        coauthorsByReference.set(number, handles);
      }
    }
  }

  return { mergeBase, references, revertedReferences, coauthorsByReference };
}

function graphql(query) {
  return githubApi(["graphql", "-f", `query=${query}`]).data;
}

function resolveReferences(numbers) {
  const nodes = new Map();
  for (let index = 0; index < numbers.length; index += 40) {
    const chunk = numbers.slice(index, index + 40);
    const fields = chunk
      .map(
        (number) => `n${number}: repository(owner: "openclaw", name: "openclaw") {
          issueOrPullRequest(number: ${number}) {
            __typename
            ... on Issue { number title author { __typename login } }
            ... on PullRequest { number title author { __typename login } }
          }
        }`,
      )
      .join("\n");
    const data = graphql(`query { ${fields} }`);
    for (const number of chunk) {
      const node = data[`n${number}`]?.issueOrPullRequest;
      if (node) {
        nodes.set(number, node);
      }
    }
  }
  return nodes;
}

function resolveCoauthors(handles) {
  const resolved = new Map();
  const uniqueHandles = [...new Set(handles)];
  for (let index = 0; index < uniqueHandles.length; index += 80) {
    const chunk = uniqueHandles.slice(index, index + 80);
    const fields = chunk
      .map(
        (handle, offset) =>
          `u${index + offset}: user(login: ${JSON.stringify(handle)}) { __typename login }`,
      )
      .join("\n");
    const data = graphql(`query { ${fields} }`);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const user = data[`u${index + offset}`];
      if (user?.__typename === "User" && isEligibleHandle(user.login)) {
        resolved.set(chunk[offset].toLowerCase(), user.login);
      }
    }
  }
  return resolved;
}

function thanksFor(node, coauthorHandles) {
  const handles = [];
  if (node.author?.__typename === "User" && isEligibleHandle(node.author.login)) {
    handles.push(node.author.login);
  }
  for (const handle of coauthorHandles) {
    if (!handles.some((candidate) => candidate.toLowerCase() === handle.toLowerCase())) {
      handles.push(handle);
    }
  }
  return handles;
}

function ledgerFor(base, target, references, nodes, coauthorsByReference, resolvedCoauthors) {
  const missing = references.filter((number) => !nodes.has(number));
  if (missing.length > 0) {
    fail(`GitHub could not resolve source references: ${missing.map((number) => `#${number}`).join(", ")}`);
  }

  const entries = references.map((number) => {
    const node = nodes.get(number);
    const rawCoauthors = coauthorsByReference.get(number) ?? new Set();
    const coauthors = [...rawCoauthors]
      .map((handle) => resolvedCoauthors.get(handle.toLowerCase()))
      .filter(Boolean);
    return {
      number,
      title: node.title.replace(/#(\d+)/g, "issue $1").replace(/\s+/g, " ").trim(),
      type: node.__typename,
      thanks: thanksFor(node, coauthors),
    };
  });

  const pullRequests = entries.filter((entry) => entry.type === "PullRequest");
  const issues = entries.filter((entry) => entry.type === "Issue");
  const renderEntry = (entry, issue = false) => {
    const attribution = entry.thanks.length > 0 ? ` Thanks ${entry.thanks.map((handle) => `@${handle}`).join(" and ")}.` : "";
    return `- ${issue ? "Reported: " : ""}${entry.title} (#${entry.number}).${attribution}`;
  };
  const ledger = [
    "### Complete contribution ledger",
    "",
    `This audited record covers the complete ${base}..${target} history: ${pullRequests.length} PRs and ${issues.length} linked issues. The grouped notes above prioritize user impact; this ledger preserves every contribution reference and eligible human credit.`,
    "",
    "#### Pull requests",
    "",
    ...pullRequests.map((entry) => renderEntry(entry)),
    "",
    "#### Linked issues",
    "",
    ...issues.map((entry) => renderEntry(entry, true)),
  ].join("\n");
  return { entries, issues, ledger, pullRequests };
}

function replaceLedger(changelog, section, ledger) {
  const beforeLedger = section.source.replace(/\n+### Complete contribution ledger[\s\S]*$/m, "").trimEnd();
  const replacement = `${beforeLedger}\n\n${ledger}\n`;
  return `${changelog.slice(0, section.start)}${replacement}${changelog.slice(section.end)}`;
}

function ledgerChecks(section, entries) {
  const errors = [];
  if (!section.source.includes("### Highlights")) {
    errors.push("missing ### Highlights");
  }
  if (!section.source.includes("### Changes")) {
    errors.push("missing ### Changes");
  }
  if (!section.source.includes("### Fixes")) {
    errors.push("missing ### Fixes");
  }
  const ledgerStart = section.source.indexOf("### Complete contribution ledger");
  if (ledgerStart < 0) {
    errors.push("missing ### Complete contribution ledger");
    return errors;
  }
  const ledger = section.source.slice(ledgerStart);
  const entryNumbers = new Set(entries.map((entry) => entry.number));
  for (const number of new Set(referencesIn(section.source))) {
    if (!entryNumbers.has(number)) {
      errors.push(`missing ledger entry for #${number}`);
    }
  }
  for (const entry of entries) {
    const prefix = entry.type === "Issue" ? "- Reported: " : "- ";
    const line = ledger
      .split("\n")
      .find((candidate) => candidate.startsWith(prefix) && candidate.includes(`(#${entry.number})`));
    if (!line) {
      errors.push(`missing ledger entry for #${entry.number}`);
      continue;
    }
    for (const handle of entry.thanks) {
      if (!line.toLowerCase().includes(`@${handle.toLowerCase()}`)) {
        errors.push(`missing Thanks @${handle} for #${entry.number}`);
      }
    }
  }
  return errors;
}

function releaseChecks(section, releaseTags) {
  const expected = section.source;
  const checks = [];
  for (const tag of releaseTags) {
    const release = githubApi([`repos/${repo}/releases/tags/${encodeURIComponent(tag)}`]);
    const suffix = release.body.slice(expected.length).trimStart();
    const matches =
      release.body === expected ||
      (release.body.startsWith(expected) && (suffix === "" || suffix.startsWith("### Release verification")));
    checks.push({
      tag,
      releaseId: release.id,
      matches,
      bodyLength: release.body.length,
    });
  }
  return checks;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let changelog = readFileSync("CHANGELOG.md", "utf8");
  let section = sectionFor(changelog, options.version);
  const source = sourceCommits(options.base, options.target);
  const preexistingNotes = section.source.replace(/\n+### Complete contribution ledger[\s\S]*$/m, "");
  const noteReferences = referencesIn(preexistingNotes);
  const revertedNoteReferences = noteReferences.filter((number) => source.revertedReferences.has(number));
  if (revertedNoteReferences.length > 0) {
    fail(
      `release notes reference reverted work: ${[
        ...new Set(revertedNoteReferences),
      ]
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  const references = [...source.references];
  appendReferences(references, noteReferences);
  const nodes = resolveReferences(references);
  const coauthorHandles = [...source.coauthorsByReference.values()].flatMap((handles) => [...handles]);
  const resolvedCoauthors = resolveCoauthors(coauthorHandles);
  const ledger = ledgerFor(
    options.base,
    options.target,
    references,
    nodes,
    source.coauthorsByReference,
    resolvedCoauthors,
  );

  if (options.writeLedger) {
    changelog = replaceLedger(changelog, section, ledger.ledger);
    writeFileSync("CHANGELOG.md", changelog);
    section = sectionFor(changelog, options.version);
  }

  const errors = ledgerChecks(section, ledger.entries);
  const github = options.checkGithub ? releaseChecks(section, options.releaseTags) : [];
  for (const check of github) {
    if (!check.matches) {
      errors.push(`GitHub release ${check.tag} does not match the ${options.version} CHANGELOG section`);
    }
  }

  const result = {
    base: options.base,
    target: options.target,
    mergeBase: source.mergeBase,
    version: options.version,
    source: {
      references: references.length,
      pullRequests: ledger.pullRequests.length,
      issues: ledger.issues.length,
    },
    github,
    errors,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${options.version}: ${ledger.pullRequests.length} PRs, ${ledger.issues.length} issues, ${errors.length === 0 ? "verified" : `${errors.length} errors`}\n`,
    );
  }
  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

main();
