import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parse } from "@babel/parser";
import { resolveImportGraphDependents } from "../test-projects.test-support.mts";

type Change = { path: string; status: string };
type Selection = {
  mode: "full" | "affected";
  reason: string;
  base?: string;
  selected: { package: string; reason: string }[];
  skipped: { package: string; reason: string }[];
};

function fullSelection(extensionIds: string[], reason: string): Selection {
  return {
    mode: "full",
    reason,
    selected: extensionIds.map((id) => ({ package: id, reason })),
    skipped: [],
  };
}

function parseSource(source: string, file: string) {
  return parse(source, {
    sourceType: "unambiguous",
    plugins: [
      ["typescript", { dts: /\.d\.[cm]?ts$/u.test(file) }],
      "decorators-legacy",
      ...(/\.[jt]sx$/u.test(file) ? ["jsx" as const] : []),
    ],
  });
}

function hasGlobalInfluence(source: string, file: string) {
  const { program, comments } = parseSource(source, file);
  // Reference directives and augmentations need compiler-wide membership.
  return (
    comments?.some((comment) => /<reference\s/u.test(comment.value)) ||
    program.body.some((node) => node.type === "TSModuleDeclaration") ||
    !program.body.some((node) => /^(?:Import|Export)/u.test(node.type))
  );
}

function opaqueDeclarationRoot(rootDir: string, affected: Set<string>) {
  const config = JSON.parse(readFileSync(resolve(rootDir, "tsconfig.json"), "utf8")) as {
    compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
  };
  const aliases = Object.entries(config.compilerOptions?.paths ?? {});
  const targetAffected = (specifier: string, declaringFile: string) => {
    const targets: string[] = [];
    if (specifier.startsWith(".")) {
      targets.push(resolve(rootDir, dirname(declaringFile), specifier));
    } else {
      for (const [alias, paths] of aliases) {
        const star = alias.indexOf("*");
        if (
          star < 0
            ? alias !== specifier
            : !specifier.startsWith(alias.slice(0, star)) ||
              !specifier.endsWith(alias.slice(star + 1))
        ) {
          continue;
        }
        const wildcard =
          star < 0 ? "" : specifier.slice(star, specifier.length - (alias.length - star - 1));
        targets.push(
          ...paths.map((path) =>
            resolve(rootDir, config.compilerOptions?.baseUrl ?? ".", path.replace("*", wildcard)),
          ),
        );
      }
      if (targets.length === 0) {
        // Dependency changes already force full checking. Unknown workspace aliases cannot be scoped.
        return /^(?:@openclaw\/|openclaw(?:\/|$))/u.test(specifier);
      }
    }
    let resolved = false;
    for (const target of targets) {
      const stem = target.replace(/(?:\.d)?\.[cm]?[jt]sx?$/u, "");
      for (const suffix of [
        "",
        ".ts",
        ".tsx",
        ".mts",
        ".cts",
        ".d.ts",
        ".d.mts",
        ".d.cts",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
      ]) {
        for (const candidate of [stem + suffix, resolve(stem, "index" + suffix)]) {
          const file = relative(rootDir, candidate).replaceAll("\\", "/");
          if (affected.has(file)) {
            return true;
          }
          resolved ||= existsSync(candidate) && statSync(candidate).isFile();
        }
      }
    }
    return !resolved;
  };
  const candidates = spawnSync(
    "git",
    [
      "grep",
      "-l",
      "-z",
      "-E",
      "module|<reference",
      "--",
      ...["src", "extensions", "packages"].flatMap((root) =>
        ["ts", "tsx", "mts", "cts"].map((extension) => `:(glob)${root}/**/*.${extension}`),
      ),
    ],
    { cwd: rootDir, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (candidates.status !== 0 && candidates.status !== 1) {
    throw new Error("Declaration-root inventory unavailable");
  }
  for (const file of candidates.stdout.split("\0").filter(Boolean)) {
    if (/\.(?:test|spec)\.ts$/u.test(file) || !existsSync(resolve(rootDir, file))) {
      continue;
    }
    const source = readFileSync(resolve(rootDir, file), "utf8");
    if (
      !/\.d\.[cm]?ts$/u.test(file) &&
      !/\bdeclare\b|(?:^|[;{}])\s*module\b|\bmodule\s+["'/]|\/\/\/\s*<reference/mu.test(source)
    ) {
      continue;
    }
    const { program, comments } = parseSource(source, file);
    if (
      comments?.some((comment) => /^\/\s*<reference\s+(?:path|types)\s*=/u.test(comment.value)) ||
      program.body.some(
        (node) =>
          node.type === "TSModuleDeclaration" &&
          node.id.type === "StringLiteral" &&
          targetAffected(node.id.value, file),
      )
    ) {
      return file;
    }
  }
  return undefined;
}

/** Use the tested tree's source edges, never a restored compiler receipt's older membership. */
export function selectAffectedBoundaryPackages(
  rootDir: string,
  extensionIds: string[],
  changes: Change[],
  base?: string,
): Selection {
  const sourcePaths: string[] = [];
  const reasons = new Map<string, string>();
  for (const change of changes) {
    const file = change.path;
    const owner = /^extensions\/([^/]+)\//u.exec(file)?.[1];
    if (owner && extensionIds.includes(owner)) {
      reasons.set(owner, `PR changes ${file}`);
    }
    if (/\.(?:md|mdx|txt|png|jpg|jpeg|gif|svg|webp)$/u.test(file)) {
      continue;
    }
    if (
      !["M", "A", "D"].includes(change.status) ||
      (change.status === "D" && !base) ||
      !/^(?:src|extensions|packages|ui\/src|test)\/.+\.[cm]?[jt]sx?$/u.test(file) ||
      /\.d\.[cm]?ts$/u.test(file)
    ) {
      return fullSelection(extensionIds, `conservative full check: ${change.status} ${file}`);
    }
    if (
      change.status !== "D" &&
      (!existsSync(resolve(rootDir, file)) || !lstatSync(resolve(rootDir, file)).isFile())
    ) {
      return fullSelection(extensionIds, `missing or nonregular source: ${file}`);
    }
    if (base && change.status !== "A") {
      const previous = execFileSync("git", ["show", `${base}:${file}`], {
        cwd: rootDir,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      });
      if (hasGlobalInfluence(previous, file)) {
        return fullSelection(extensionIds, `previous global or ambient declaration: ${file}`);
      }
    }
    sourcePaths.push(file);
  }
  const affected = new Set([
    ...sourcePaths,
    ...resolveImportGraphDependents(sourcePaths, rootDir, {
      tooling: true,
      resolveAliases: true,
    }),
  ]);
  if (sourcePaths.length > 0) {
    const opaqueRoot = opaqueDeclarationRoot(rootDir, affected);
    if (opaqueRoot) {
      return fullSelection(extensionIds, `opaque declaration/reference root: ${opaqueRoot}`);
    }
  }
  for (const file of affected) {
    if (
      !/^(?:src|extensions|packages)\//u.test(file) ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)
    ) {
      continue;
    }
    if (/\.d\.[cm]?ts$/u.test(file)) {
      return fullSelection(extensionIds, `declaration dependency influence: ${file}`);
    }
    if (/^extensions\/(?:browser|xai)\//u.test(file)) {
      return fullSelection(
        extensionIds,
        `package declaration aliases differ from source graph: ${file}`,
      );
    }
    // Deleted module candidates remain in the graph's resolver inventory. Their
    // previous bytes were checked above; surviving importers still select owners.
    if (!existsSync(resolve(rootDir, file))) {
      if (base && changes.some((change) => change.path === file && change.status === "D")) {
        continue;
      }
      return fullSelection(extensionIds, `missing source: ${file}`);
    }
    const source = readFileSync(resolve(rootDir, file), "utf8");
    // Augmentation and script globals affect consumers without a module import edge.
    if (hasGlobalInfluence(source, file)) {
      return fullSelection(extensionIds, `global or ambient declaration influence: ${file}`);
    }
    const owner = /^extensions\/([^/]+)\//u.exec(file)?.[1];
    if (owner && extensionIds.includes(owner) && !reasons.has(owner)) {
      reasons.set(owner, `transitive source/type dependency: ${file}`);
    }
  }
  return {
    mode: "affected",
    reason: "PR merge-base diff and current source/type dependency graph",
    selected: extensionIds.flatMap((id) => {
      const reason = reasons.get(id);
      return reason ? [{ package: id, reason }] : [];
    }),
    skipped: extensionIds
      .filter((id) => !reasons.has(id))
      .map((id) => ({ package: id, reason: "unaffected by PR diff; main drift covered hourly" })),
  };
}

export function resolveExtensionBoundarySelection(
  rootDir: string,
  extensionIds: string[],
  env: NodeJS.ProcessEnv = process.env,
): Selection {
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    return fullSelection(extensionIds, "full check outside pull_request");
  }
  if (["1", "true", "full"].includes(env.OPENCLAW_CI_EXTENSION_BOUNDARY_FULL?.trim() ?? "")) {
    return fullSelection(extensionIds, "OPENCLAW_CI_EXTENSION_BOUNDARY_FULL kill switch");
  }
  const revision = env.OPENCLAW_CI_EXTENSION_BOUNDARY_BASE ?? "";
  if (!/^[a-f0-9]{40}$/u.test(revision)) {
    return fullSelection(extensionIds, "missing pinned PR comparison base");
  }
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: rootDir, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  try {
    const base = git(["merge-base", revision, "HEAD"]).trim();
    if (base !== revision) {
      return fullSelection(extensionIds, "PR comparison base is not an ancestor of tested HEAD");
    }
    const fields = git([
      "diff",
      "--name-status",
      "--no-renames",
      "-z",
      `${base}...HEAD`,
      "--",
    ]).split("\0");
    fields.pop();
    if (fields.length % 2 !== 0) {
      return fullSelection(extensionIds, "incomplete PR diff");
    }
    const changes: Change[] = [];
    for (let index = 0; index < fields.length; index += 2) {
      changes.push({ status: fields[index]!, path: fields[index + 1]! });
    }
    return { ...selectAffectedBoundaryPackages(rootDir, extensionIds, changes, base), base };
  } catch {
    return fullSelection(extensionIds, "PR diff or dependency graph unavailable");
  }
}

export function formatBoundarySelection(selection: Selection) {
  const safe = (text: string) => text.replace(/[|\r\n<>`]/gu, " ");
  return [
    "## Extension package boundary selection",
    "",
    `${selection.selected.length} selected, ${selection.skipped.length} skipped. ${selection.reason}.`,
    ...(selection.base ? [`Comparison base: ${selection.base}.`] : []),
    "The negative boundary canary still runs. Selected packages retain full diagnostics and receipt validation.",
    "",
    "| Package | Decision | Reason |",
    "| --- | --- | --- |",
    ...selection.selected.map((row) => `| ${safe(row.package)} | selected | ${safe(row.reason)} |`),
    ...selection.skipped.map((row) => `| ${safe(row.package)} | skipped | ${safe(row.reason)} |`),
    "",
  ].join("\n");
}
