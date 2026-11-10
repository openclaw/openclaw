import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

export const dependencyFileBytes = 25_000;
const dependencyTimestamp = new Date("2020-01-02T03:04:05Z");

/** Unanchored node_modules/ includes tool-local dependencies under .artifacts too. */
export function dependencyFixturePaths(): string[] {
  const groups: Array<[number, (index: number) => string]> = [
    [8539, (i) => `node_modules/next/dist/server/chunks/group-${Math.floor(i / 64)}/${i}.js`],
    [4354, (i) => `node_modules/lucide-react/dist/esm/icons/icon-${i}.js`],
    [3025, (i) => `node_modules/es-toolkit/dist/compat/group-${Math.floor(i / 64)}/${i}.js`],
    [2718, (i) => `node_modules/@babel/plugin-${Math.floor(i / 48)}/lib/${i}.js`],
    [
      41608,
      (i) =>
        `node_modules/package-${Math.floor(i / 128)}/lib/esm/${Math.floor((i % 128) / 32)}/${i}.js`,
    ],
    [
      2889,
      (i) =>
        `.artifacts/convex-proof-cli/node_modules/convex/dist/group-${Math.floor(i / 64)}/${i}.js`,
    ],
    [
      2745,
      (i) => `.artifacts/node-runtime/node_modules/runtime/lib/group-${Math.floor(i / 64)}/${i}.js`,
    ],
  ];
  return [
    ...groups.flatMap(([count, file]) => Array.from({ length: count }, (_, i) => file(i))),
    ".env.local",
    ".convex/.gitignore",
  ];
}

export async function seedDependencyFixture(root: string): Promise<void> {
  const files = dependencyFixturePaths();
  const directories = new Set(files.map((file) => path.dirname(path.join(root, file))));
  for (const directory of directories) {
    await fs.mkdir(directory, { recursive: true });
  }
  const bytes = Buffer.alloc(dependencyFileBytes, 120);
  for (const [index, file] of files.entries()) {
    bytes.writeUInt32LE(index, 0);
    const target = path.join(root, file);
    await fs.writeFile(target, bytes, { mode: index % 97 === 0 ? 0o755 : 0o640 });
    await fs.utimes(target, dependencyTimestamp, dependencyTimestamp);
  }
  await fs.mkdir(path.join(root, ".artifacts", "not-selected"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".artifacts", "not-selected", "private.txt"),
    "excluded synthetic bytes",
  );
  await fs.writeFile(
    path.join(root, ".gitignore"),
    "node_modules/\n.artifacts/\n.env.local\n.convex/\n",
  );
  await fs.writeFile(path.join(root, ".worktreeinclude"), ".env.local\n.convex/\nnode_modules/\n");
}

export async function verifyDependencyFixture(root: string): Promise<void> {
  const expected = Buffer.alloc(dependencyFileBytes, 120);
  for (const [index, file] of dependencyFixturePaths().entries()) {
    expected.writeUInt32LE(index, 0);
    const target = path.join(root, file);
    assert.deepEqual(await fs.readFile(target), expected, file);
    const stat = await fs.stat(target);
    assert.equal(stat.mode & 0o7777, index % 97 === 0 ? 0o755 : 0o640, file);
    assert.equal(stat.mtimeMs, dependencyTimestamp.getTime(), file);
  }
  await assert.rejects(fs.stat(path.join(root, ".artifacts", "not-selected")), { code: "ENOENT" });
}
