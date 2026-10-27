import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listDirectoryTreeStrict } from "openclaw/plugin-sdk/file-access-runtime";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { contract } from "./contract.js";
import { defaultOrder } from "./test-support.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const names = [
  "knowledge-automation",
  "knowledge-capture",
  "knowledge-correct",
  "knowledge-entities",
  "knowledge-ingest",
  "knowledge-meeting-ingest",
  "knowledge-recall",
  "knowledge-source-ingest",
  "knowledge-unlinked-claims",
];

it("packaged skills have discoverable metadata and self-contained readable references", async () => {
  execFileSync(process.execPath, ["scripts/sync-skill-references.mjs", "--check"], { cwd: root });
  const manifest = JSON.parse(await readFile(path.join(root, "openclaw.plugin.json"), "utf8"));
  expect(manifest.skills).toStrictEqual(["./skills"]);
  const skills = (await readdir(path.join(root, "skills")))
    .filter((n) => n.startsWith("knowledge-"))
    .toSorted(defaultOrder);
  expect(skills).toStrictEqual(names);
  const tools = new Set<string>(
    Object.values(contract.operations).flatMap((op) => ("tool" in op ? [op.tool.name] : [])),
  );
  expect([...manifest.contracts.tools].toSorted(defaultOrder)).toStrictEqual(
    [...tools].toSorted(defaultOrder),
  );
  expect(tools.has("knowledge_recall")).toBeTruthy();
  for (const name of names) {
    const dir = path.join(root, "skills", name);
    const pending = ["SKILL.md"],
      seen = new Set();
    while (pending.length) {
      const file = pending.pop()!;
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      const contents = await readFile(path.join(dir, file), "utf8");
      if (file === "SKILL.md") {
        const frontmatter = parse(contents.match(/^---\n([\s\S]*?)\n---/)![1]!);
        expect(frontmatter.name).toBe(name);
        expect(
          frontmatter.description.length > 0 && frontmatter.description.length <= 1024,
        ).toBeTruthy();
      }
      for (const [, link] of contents.matchAll(/\]\(([^)]+\.md)\)/g)) {
        const target = path.normalize(path.join(path.dirname(file), link!));
        expect(
          !target.startsWith("..") && !path.isAbsolute(target),
          `${name}: reference escapes skill bundle`,
        ).toBeTruthy();
        pending.push(target);
      }
      for (const [tool] of contents.matchAll(/\bknowledge_[a-z_]+\b/g)) {
        expect(tools.has(tool), `Unavailable tool ${tool} in ${name}/${file}`).toBeTruthy();
      }
    }
  }
});

// Bundled builds copy the manifest-declared skills directory recursively into
// dist (scripts/copy-bundled-plugin-metadata.mts), so its tree is the payload.
it("bundled skill payload includes all skill entrypoints, references and upstream attribution", async () => {
  const skillFiles = (await listDirectoryTreeStrict(path.join(root, "skills")))
    .filter((entry) => entry.dirent.isFile())
    .map((entry) => path.join("skills", entry.relativePath).replaceAll(path.sep, "/"));
  const files = new Set(skillFiles);
  for (const name of names) {
    expect(files.has(`skills/${name}/SKILL.md`)).toBeTruthy();
    if (name === "knowledge-automation") {
      continue;
    }
    expect(files.has(`skills/${name}/references/conventions.md`)).toBeTruthy();
    if (name !== "knowledge-recall") {
      expect(files.has(`skills/${name}/references/publication.md`)).toBeTruthy();
    }
    if (name === "knowledge-source-ingest") {
      expect(files.has(`skills/${name}/references/source-manifest.md`)).toBeTruthy();
      expect(files.has(`skills/${name}/scripts/source-manifest.mjs`)).toBeTruthy();
      expect(files.has(`skills/${name}/scripts/discrawl-normalize.mjs`)).toBeTruthy();
    }
  }
  await expect(readFile(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8")).resolves.toBeTruthy();
  await expect(
    readFile(path.join(root, "scripts/sync-skill-references.mjs"), "utf8"),
  ).resolves.toBeTruthy();
  expect(skillFiles.some((file) => /\.test\.|(^|\/)test\//.test(file))).toBe(false);
});
