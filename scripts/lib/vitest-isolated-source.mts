import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type IsolatedVitestMount = { source: string; target: string };
const PRIVATE_SEGMENT =
  /^(?:\.git|\.openclaw|\.local|\.artifacts|\.env(?:\..*)?|node_modules|dist)$/u;

export function isIsolatedSourcePath(file: string): boolean {
  return (
    file !== "" &&
    !path.isAbsolute(file) &&
    !file.split("/").some((part) => part === ".." || part === "." || PRIVATE_SEGMENT.test(part)) &&
    !/[\\\0\r\n]/u.test(file)
  );
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("../") && !path.isAbsolute(relative));
}

function admittedRealPath(root: string, file: string): string {
  const real = fs.realpathSync(file);
  if (!within(root, real)) {
    throw new Error(`Dependency/source symlink escapes the checkout: ${path.relative(root, file)}`);
  }
  return real;
}

/** Copy current working-tree bytes, not HEAD or the index's older blob contents. */
export function copyIsolatedVitestSource(root: string, snapshot: string, tracked: string[]) {
  const admitted = new Set(tracked.filter(isIsolatedSourcePath));
  const digest = createHash("sha256");
  const copied = new Set<string>();
  const links: string[] = [];
  for (const file of [...admitted].toSorted()) {
    const source = path.join(root, file);
    // A tracked deletion remains a deletion in this invocation.
    const stat = fs.lstatSync(source, { throwIfNoEntry: false });
    digest.update(file + "\0");
    if (!stat) {
      digest.update("deleted\0");
      continue;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error(`Unsupported tracked source entry: ${file}`);
    }
    // Reject directory symlinks in ancestors too; copying through one can expose
    // an untracked tree even when the final component is an ordinary file.
    const parent = path.dirname(source);
    if (fs.realpathSync(parent) !== parent) {
      throw new Error(`Source has a symlinked parent: ${file}`);
    }
    const destination = path.join(snapshot, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(source);
      const real = admittedRealPath(root, source);
      const relative = path.relative(root, real);
      if (path.isAbsolute(target) || !isIsolatedSourcePath(relative)) {
        throw new Error(`Unsupported source symlink: ${file}`);
      }
      fs.symlinkSync(target, destination);
      digest.update("symlink\0" + target + "\0");
      links.push(file);
    } else {
      const bytes = fs.readFileSync(source);
      fs.writeFileSync(destination, bytes, { mode: stat.mode & 0o777 });
      digest
        .update(String(stat.mode & 0o777) + "\0")
        .update(bytes)
        .update("\0");
    }
    copied.add(file);
  }
  for (const file of links) {
    // An in-root symlink is insufficient: its target must actually be present
    // in the tracked snapshot, rather than silently resolving to an old build.
    if (!fs.existsSync(path.join(snapshot, file))) {
      throw new Error(`Source symlink targets excluded/untracked content: ${file}`);
    }
  }
  return { digest: digest.digest("hex"), copied };
}

/** A writable module-directory shell with immutable installed packages underneath. */
export function prepareIsolatedVitestDependencies(
  root: string,
  snapshot: string,
  copied: ReadonlySet<string>,
): IsolatedVitestMount[] {
  const mounts: IsolatedVitestMount[] = [];
  const moduleDirs = [
    "node_modules",
    ...[...copied]
      .filter((file) => file.endsWith("/package.json"))
      .map((file) => path.join(path.dirname(file), "node_modules")),
  ];
  const checked = new Set<string>();
  const dotenvFiles: string[] = [];
  const checkTree = (directory: string): void => {
    if (checked.has(directory)) {
      return;
    }
    checked.add(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (/^\.env(?:\..*)?$/u.test(entry.name) && entry.isFile()) {
        dotenvFiles.push(path.relative(root, file));
        continue;
      }
      if (/^(?:\.git|\.openclaw|\.env(?:\..*)?)$/u.test(entry.name)) {
        throw new Error(`Private metadata in prepared dependencies: ${path.relative(root, file)}`);
      }
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        const real = admittedRealPath(root, file);
        if (path.isAbsolute(target)) {
          throw new Error(
            `Absolute dependency symlink is not relocatable: ${path.relative(root, file)}`,
          );
        }
        const relative = path.relative(root, real);
        if (
          !relative.split(path.sep).includes("node_modules") &&
          !copied.has(relative) &&
          !copied.has(path.join(relative, "package.json"))
        ) {
          throw new Error(
            `Dependency targets untracked workspace content: ${path.relative(root, file)}`,
          );
        }
      } else if (entry.isDirectory()) {
        checkTree(file);
      } else if (!entry.isFile()) {
        throw new Error(`Unsupported dependency entry: ${path.relative(root, file)}`);
      }
    }
  };
  const project = (source: string, destination: string, relative: string): void => {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const file = path.join(source, entry.name);
      const target = path.join(destination, entry.name);
      const targetRelative = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) {
        fs.symlinkSync(fs.readlinkSync(file), target);
      } else if (entry.isDirectory()) {
        if (entry.name === ".bin") {
          // pnpm's generated shims embed the install root in NODE_PATH. Rewrite
          // only that literal root in the private copy, never the installed shim.
          fs.mkdirSync(target);
          for (const bin of fs.readdirSync(file)) {
            const shim = path.join(file, bin);
            if (!fs.lstatSync(shim).isFile()) {
              throw new Error(`Unsupported prepared executable shim: ${shim}`);
            }
            fs.writeFileSync(
              target + "/" + bin,
              fs.readFileSync(shim, "utf8").replaceAll(root, "/workspace"),
              { mode: 0o755 },
            );
          }
        } else if (entry.name === ".pnpm" || fs.existsSync(path.join(file, "package.json"))) {
          fs.mkdirSync(target);
          mounts.push({ source: file, target: `/workspace/${targetRelative}` });
        } else if (!entry.name.startsWith(".")) {
          project(file, target, targetRelative);
        }
        // Caches/installation state are deliberately not projected. Vite and
        // ordinary build prerequisites can create their private outputs here.
      }
    }
  };
  for (const relative of new Set(moduleDirs)) {
    const source = path.join(root, relative);
    const stat = fs.lstatSync(source, { throwIfNoEntry: false });
    if (!stat) {
      continue;
    }
    if (!stat.isDirectory() || fs.realpathSync(source) !== source) {
      throw new Error(`Prepared node_modules must be a real checkout-owned directory: ${relative}`);
    }
    checkTree(source);
    project(source, path.join(snapshot, relative), relative);
  }
  if (!mounts.some((mount) => mount.target === "/workspace/node_modules/.pnpm")) {
    throw new Error("Isolation requires a prepared, checkout-local pnpm node_modules/.pnpm tree.");
  }
  if (dotenvFiles.length) {
    // Some published packages include dotenv fixtures. Mask, never read/copy,
    // their contents; the underlying installation remains readonly and intact.
    const empty = path.join(snapshot, ".vitest-isolated-empty-env");
    fs.writeFileSync(empty, "", { mode: 0o444 });
    mounts.push(...dotenvFiles.map((file) => ({ source: empty, target: `/workspace/${file}` })));
  }
  return mounts;
}
