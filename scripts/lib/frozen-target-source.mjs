import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const maxObjectBytes = 16 * 1024 * 1024;
const maxReadBytes = 64 * 1024 * 1024;
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function createFrozenTargetSource(root, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("selected source requires a full lowercase commit SHA");
  }
  const deadline = Date.now() + 30_000;
  let remainingBytes = maxReadBytes;
  // Ambient Git routing must not redirect a selected repository or its objects.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  Object.assign(env, {
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  });
  const git = (...args) => {
    try {
      const timeout = deadline - Date.now();
      if (timeout <= 0 || remainingBytes <= 0) {
        throw new Error("source read limit exceeded");
      }
      const output = execFileSync("git", ["-C", root, ...args], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
        maxBuffer: Math.min(maxObjectBytes, remainingBytes),
      });
      remainingBytes -= output.length;
      return output;
    } catch {
      throw new Error(`unable to read selected source (${args[0]})`);
    }
  };
  const version = /^git version (\d+)\.(\d+)/.exec(textDecoder.decode(git("--version")));
  if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 45)) {
    throw new Error("frozen source reads require Git 2.45 or newer (no lazy fetch)");
  }
  if (textDecoder.decode(git("rev-parse", "--verify", "HEAD")).trim() !== sha) {
    throw new Error("selected source checkout does not match OPENCLAW_SELECTED_SHA");
  }
  const readObject = (oid, type) => {
    if (textDecoder.decode(git("cat-file", "-t", oid)).trim() !== type) {
      throw new Error(`expected committed ${type} object`);
    }
    const content = git("cat-file", type, oid);
    const actual = createHash("sha1")
      .update(`${type} ${content.length}\0`)
      .update(content)
      .digest("hex");
    if (actual !== oid) {
      throw new Error("unable to read selected source (object hash mismatch)");
    }
    return content;
  };
  const readTree = (oid) => {
    readObject(oid, "tree");
    const names = new Set();
    return textDecoder
      .decode(git("ls-tree", "-z", oid))
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const match = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40})\t([^\0/]+)$/.exec(line);
        if (!match || names.has(match[4]) || match[4] === "." || match[4] === "..") {
          throw new Error("invalid selected source tree entry");
        }
        names.add(match[4]);
        return { mode: match[1], type: match[2], oid: match[3], name: match[4] };
      });
  };
  const commit = readObject(sha, "commit");
  const rootTree = /^tree ([0-9a-f]{40})\n/.exec(textDecoder.decode(commit))?.[1];
  if (!rootTree) {
    throw new Error("invalid selected source commit tree");
  }
  const rootEntries = readTree(rootTree);
  const lookup = (relativePath, type) => {
    const parts = relativePath.split("/");
    if (
      relativePath.length > 4096 ||
      parts.length > 64 ||
      parts.some((part) => !part || part === "." || part === ".." || /[\0\\]/.test(part))
    ) {
      throw new Error("unsafe selected source path");
    }
    let entries = rootEntries;
    for (const [index, part] of parts.entries()) {
      const entry = entries.find((candidate) => candidate.name === part);
      if (!entry) {
        return null;
      }
      const expectedType = index === parts.length - 1 ? type : "tree";
      const validMode =
        expectedType === "tree"
          ? entry.mode === "040000"
          : entry.mode === "100644" || entry.mode === "100755";
      if (entry.type !== expectedType || !validMode) {
        throw new Error(
          `expected ${expectedType === "tree" ? "committed directory" : "regular committed file"} for ${relativePath}`,
        );
      }
      if (index === parts.length - 1) {
        return readObject(entry.oid, expectedType);
      }
      entries = readTree(entry.oid);
    }
    return null;
  };
  return {
    readText(relativePath) {
      const content = lookup(relativePath, "blob");
      return content === null ? null : textDecoder.decode(content);
    },
    hasPath(relativePath) {
      return lookup(relativePath, "blob") !== null;
    },
    hasDirectory(relativePath) {
      return lookup(relativePath, "tree") !== null;
    },
  };
}

let invokedAsMain = false;
if (process.argv[1]) {
  try {
    invokedAsMain =
      realpathSync.native(fileURLToPath(import.meta.url)) === realpathSync.native(process.argv[1]);
  } catch {
    // Inline and stdin importers need not have a filesystem entrypoint.
  }
}

if (invokedAsMain) {
  try {
    const [operation, root, sha, relativePath, needle] = process.argv.slice(2);
    const source = createFrozenTargetSource(root, sha);
    let present = true;
    switch (operation) {
      case "validate":
        break;
      case "has":
        present = source.hasPath(relativePath);
        break;
      case "directory":
        present = source.hasDirectory(relativePath);
        break;
      case "contains":
        if (!needle) {
          throw new Error("missing selected source text");
        }
        // Consume the bounded blob before matching; no early grep/SIGPIPE exit.
        present = source.readText(relativePath)?.includes(needle) ?? false;
        break;
      default:
        throw new Error("unknown frozen source operation");
    }
    process.exitCode = present ? 0 : 1;
  } catch (error) {
    console.error(`frozen source: ${error.message}`);
    process.exitCode = 2;
  }
}
