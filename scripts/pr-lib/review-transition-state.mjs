import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";

const [source, target] = process.argv.slice(2);
const readBuffer = Buffer.alloc(128 * 1024);

function git(...args) {
  const output = execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  // Git emits filenames, so an initial U+FEFF belongs to the first path.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output);
}

function records(...args) {
  return git(...args)
    .split("\0")
    .filter(Boolean);
}

function tree(commit) {
  return new Map(
    records("ls-tree", "-r", "-z", commit).map((record) => {
      const match = /^([0-7]{6}) (?:blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
      if (!match) {
        throw new Error("Invalid transition tree entry");
      }
      return [match[3], `${match[1]} ${match[2]}`];
    }),
  );
}

function stat(pathname) {
  try {
    return fs.lstatSync(pathname);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

function worktreeEntry(pathname) {
  const parts = pathname.split("/");
  // A source file/symlink can occupy a target directory. Never follow it to
  // inspect target descendants outside the worktree.
  for (let count = 1; count < parts.length; count += 1) {
    if (!stat(parts.slice(0, count).join("/"))?.isDirectory()) {
      return undefined;
    }
  }
  const before = stat(pathname);
  if (!before || before.isDirectory()) {
    return undefined;
  }
  const mode = before.isSymbolicLink()
    ? "120000"
    : before.isFile()
      ? before.mode & 0o100
        ? "100755"
        : "100644"
      : undefined;
  if (!mode) {
    throw new Error(`Unsupported working-tree entry ${JSON.stringify(pathname)}`);
  }
  const hash = createHash("sha1");
  if (before.isSymbolicLink()) {
    const bytes = fs.readlinkSync(pathname, { encoding: "buffer" });
    hash.update(`blob ${bytes.length}\0`).update(bytes);
  } else {
    hash.update(`blob ${before.size}\0`);
    const fd = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error("Transition file changed while opening");
      }
      let count;
      while ((count = fs.readSync(fd, readBuffer, 0, readBuffer.length, null)) > 0) {
        hash.update(readBuffer.subarray(0, count));
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  const after = stat(pathname);
  if (
    !after ||
    ["dev", "ino", "mode", "size", "mtimeMs", "ctimeMs"].some((key) => before[key] !== after[key])
  ) {
    throw new Error(`Transition file changed while reading ${JSON.stringify(pathname)}`);
  }
  return `${mode} ${hash.digest("hex")}`;
}

try {
  if (
    process.argv.length !== 4 ||
    !/^[a-f0-9]{40}$/.test(source) ||
    !/^[a-f0-9]{40}$/.test(target)
  ) {
    throw new Error("Invalid transition endpoints");
  }
  const from = tree(source);
  const to = tree(target);
  const index = new Map(
    records("ls-files", "--stage", "-z").map((record) => {
      const match = /^([0-7]{6}) ([a-f0-9]{40}) 0\t([\s\S]+)$/.exec(record);
      if (!match) {
        throw new Error("Unmerged transition index");
      }
      return [match[3], `${match[1]} ${match[2]}`];
    }),
  );
  // Intent-to-add has a normal H tag and can match an empty endpoint blob.
  // Compare both Git views; retain all hidden flags and conflict metadata on refusal.
  const indexDiff = [
    "diff",
    "--cached",
    "--raw",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "-z",
  ];
  if (
    records("ls-files", "-v", "-z").some((record) => record[0] !== "H") ||
    records("ls-files", "--resolve-undo", "-z").length > 0 ||
    git(...indexDiff, "--ita-visible-in-index", source) !==
      git(...indexDiff, "--ita-invisible-in-index", source)
  ) {
    throw new Error("Transition index contains hidden or unsupported entries");
  }
  const inspect = new Set(
    records(
      "-c",
      "core.filemode=true",
      "-c",
      "core.ignoreStat=false",
      "diff-files",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-only",
      "-z",
    ),
  );
  for (const pathname of new Set([...from.keys(), ...to.keys(), ...index.keys()])) {
    const entry = index.get(pathname);
    if (entry !== from.get(pathname) && entry !== to.get(pathname)) {
      throw new Error(
        `Index entry ${JSON.stringify(pathname)} is neither its journaled source nor target entry`,
      );
    }
    if (from.get(pathname) !== to.get(pathname)) {
      inspect.add(pathname);
    }
  }
  for (const pathname of records("ls-files", "--others", "--exclude-standard", "-z")) {
    if (pathname === ".local" || pathname.startsWith(".local/")) {
      continue;
    }
    if (!from.has(pathname) && !to.has(pathname)) {
      throw new Error(`Untracked entry ${JSON.stringify(pathname)} is not owned by the transition`);
    }
    inspect.add(pathname);
  }
  for (const pathname of inspect) {
    const entry = worktreeEntry(pathname);
    if (entry !== from.get(pathname) && entry !== to.get(pathname)) {
      throw new Error(
        `Working-tree entry ${JSON.stringify(pathname)} is neither its journaled source nor target entry`,
      );
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
