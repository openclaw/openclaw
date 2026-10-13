import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { validateReviewArtifacts } from "./review-artifacts.mjs";

const executable = process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git";
const incomingPaths = [
  ".local/correction-incoming-meta.json",
  ".local/correction-incoming-meta.env",
  ".local/correction-original-review.json",
];
const livePaths = [".local/pr-meta.json", ".local/pr-meta.env", ".local/review.json"];
export const incomingHash = (bytes) =>
  execFileSync(executable, ["hash-object", "--no-filters", "--stdin"], {
    input: bytes,
    encoding: "utf8",
  }).trim();
export function readIncomingFile(path) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) {
      throw new Error(`Expected regular incoming authority: ${path}`);
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (["size", "mtimeMs", "ctimeMs"].some((key) => before[key] !== after[key])) {
      throw new Error(`Incoming authority changed while reading: ${path}`);
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

// The same resolver serves current correction review and signed historical replay.
// A retained copy is usable only with native admission's metadata digests (or the
// signed baseline's original digests), never merely because a backup exists.
export function resolveIncoming({
  pr,
  incoming,
  reviewOid,
  metaOid,
  envOid,
  paths,
  read = readIncomingFile,
}) {
  const retained = incomingPaths
    .slice(0, 2)
    .some((path) => fs.lstatSync(path, { throwIfNoEntry: false }));
  const selected = paths ?? (retained ? incomingPaths : livePaths);
  if ((retained || paths) && (!metaOid || !envOid)) {
    throw new Error("Retained incoming metadata needs native admission bindings.");
  }
  const bytes = selected.map(read);
  const oids = bytes.map(incomingHash);
  for (const [index, expected] of [metaOid, envOid, reviewOid].entries()) {
    if (
      (index === 2 || expected) &&
      (!/^[a-f0-9]{40}$/u.test(expected ?? "") || oids[index] !== expected)
    ) {
      throw new Error(
        index === 2
          ? "Correction approval does not bind these exact incoming review bytes."
          : `Incoming authority changed: ${livePaths[index]}`,
      );
    }
  }
  const meta = JSON.parse(bytes[0]);
  const review = JSON.parse(bytes[2]);
  const violations = validateReviewArtifacts({ review, prMeta: meta });
  if (violations.length) {
    throw new Error(violations.join("\n"));
  }
  if (meta.number !== pr || meta.headRefOid !== incoming) {
    throw new Error("Correction preparation does not match the incoming PR review.");
  }
  const findings = review.findings.filter(({ severity }) =>
    ["BLOCKER", "IMPORTANT"].includes(severity),
  );
  if (
    review.recommendation !== "NEEDS WORK" ||
    !findings.length ||
    new Set(findings.map(({ id }) => id)).size !== findings.length
  ) {
    throw new Error("Correction admission requires NEEDS WORK with distinct actionable findings.");
  }
  return { meta, review, findings, bytes, oids };
}

export function retainIncoming({ bytes }) {
  // Check every existing destination before installing anything. Retry may finish
  // an interrupted copy, but never replace any previously retained authority.
  for (const [index, path] of incomingPaths.entries()) {
    if (
      fs.lstatSync(path, { throwIfNoEntry: false }) &&
      !readIncomingFile(path).equals(bytes[index])
    ) {
      throw new Error(`Retained incoming authority differs: ${path}`);
    }
  }
  for (const [index, path] of incomingPaths.entries()) {
    if (!fs.lstatSync(path, { throwIfNoEntry: false })) {
      fs.writeFileSync(path, bytes[index], { flag: "wx", mode: 0o600 });
    }
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    const [command, pr, incoming, reviewOid, ...extra] = process.argv.slice(2);
    if (command !== "retain" || extra.length) {
      throw new Error("Expected retain PR incoming review-oid.");
    }
    const authority = resolveIncoming({ pr: Number(pr), incoming, reviewOid });
    retainIncoming(authority);
    process.stdout.write(
      `PREP_INCOMING_META_OID=${authority.oids[0]}\nPREP_INCOMING_ENV_OID=${authority.oids[1]}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
