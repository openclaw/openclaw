import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectModuleReferencesFromSource } from "./guard-inventory-utils.mjs";
import { createNativeTypeScriptParser } from "./native-typescript.mts";

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

// Greedy direct public-SDK coverage: 98 + 16 + 5 distinct entries across these packages.
const SMOKE_PACKAGES = ["telegram", "codex", "slack"];
const SOURCE = /\.[cm]?[jt]sx?$/u;

function publicEntries(rootDir: string, base?: string) {
  const read = (name: string, revision?: string): string[] => {
    const file = `scripts/lib/plugin-sdk-${name}.json`;
    return JSON.parse(
      revision
        ? execFileSync("git", ["show", `${revision}:${file}`], { cwd: rootDir, encoding: "utf8" })
        : readFileSync(resolve(rootDir, file), "utf8"),
    );
  };
  return new Set(
    [undefined, ...(base ? [base] : [])].flatMap((revision) => {
      const privateEntries = new Set(read("private-local-only-subpaths", revision));
      return read("entrypoints", revision).filter((entry) => !privateEntries.has(entry));
    }),
  );
}

/** PR scope intentionally omits transitive declaration consumers; hourly checks them all. */
export function selectAffectedBoundaryPackages(
  rootDir: string,
  extensionIds: string[],
  changes: Change[],
  base?: string,
): Selection {
  const reasons = new Map<string, string>();
  let sharedChange: string | undefined;
  const changedEntries = new Set<string>();
  const entries = changes.some(({ path }) => path.startsWith("src/plugin-sdk/"))
    ? publicEntries(rootDir, base)
    : new Set<string>();
  for (const { path: file } of changes) {
    const owner = /^extensions\/([^/]+)\//u.exec(file)?.[1];
    if (owner && extensionIds.includes(owner)) {
      reasons.set(owner, `PR changes ${file}`);
    }
    const entry = /^src\/plugin-sdk\/([^/]+)\.ts$/u.exec(file)?.[1];
    if (entry && entries.has(entry)) {
      changedEntries.add(`openclaw/plugin-sdk/${entry}`);
    }
    if (
      (/^(?:src|packages)\//u.test(file) &&
        SOURCE.test(file) &&
        !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)) ||
      /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json)$/u.test(file) ||
      /^scripts\/(?:lib\/plugin-sdk-|(?:prepare|check|compile)-extension.*boundary)/u.test(file)
    ) {
      sharedChange ??= file;
    }
  }
  if (sharedChange) {
    for (const id of SMOKE_PACKAGES) {
      if (extensionIds.includes(id) && !reasons.has(id)) {
        reasons.set(id, `SDK smoke sample for ${sharedChange}`);
      }
    }
  }
  if (changedEntries.size > 0) {
    const files = execFileSync("git", ["ls-files", "-z", "--", "extensions"], {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    })
      .split("\0")
      .filter((file) => SOURCE.test(file) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file));
    const sources: { fileName: string; text: string; owner: string }[] = [];
    for (const file of files) {
      const owner = file.split("/")[1]!;
      if (
        !extensionIds.includes(owner) ||
        reasons.has(owner) ||
        !existsSync(resolve(rootDir, file))
      ) {
        continue;
      }
      if (!lstatSync(resolve(rootDir, file)).isFile()) {
        reasons.set(owner, `nonregular package source: ${file}`);
        continue;
      }
      const source = readFileSync(resolve(rootDir, file), "utf8");
      if (!source.includes("openclaw/plugin-sdk/") && !source.includes("\\")) {
        continue;
      }
      sources.push({ fileName: file, text: source, owner });
    }
    using parser = createNativeTypeScriptParser({ cwd: rootDir });
    for (const [index, sourceFile] of parser.parseSourceFiles(sources).entries()) {
      const { owner, fileName } = sources[index]!;
      const direct = collectModuleReferencesFromSource(sourceFile, {
        acceptSpecifier: (specifier) => changedEntries.has(specifier),
      })[0];
      if (direct && !reasons.has(owner)) {
        reasons.set(
          owner,
          `direct import of changed public entry ${direct.specifier}: ${fileName}`,
        );
      }
    }
  }

  return {
    mode: "affected",
    reason: "PR diff: touched packages, SDK smoke sample and direct public-entry consumers",
    selected: extensionIds.flatMap((id) => {
      const reason = reasons.get(id);
      return reason ? [{ package: id, reason }] : [];
    }),
    skipped: extensionIds
      .filter((id) => !reasons.has(id))
      .map((id) => ({
        package: id,
        reason: "outside PR selection; transitive consumers and main drift covered hourly",
      })),
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
    execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: "pipe",
    });
  try {
    git(["cat-file", "-e", `${revision}^{commit}`]);
  } catch {
    return fullSelection(
      extensionIds,
      `pinned PR comparison base unavailable in checkout: ${revision}`,
    );
  }
  try {
    // Depth-one checkouts hide parent edges from revision walks. The raw merge
    // header still authenticates the pinned first parent without deepening HEAD.
    const headers = git(["cat-file", "-p", "HEAD"]).split("\n\n", 1)[0]!;
    const parents = [...headers.matchAll(/^parent ([a-f0-9]{40})$/gmu)].map((match) => match[1]);
    const base =
      parents.length > 1 && parents[0] === revision
        ? revision
        : git(["merge-base", revision, "HEAD"]).trim();
    if (base !== revision) {
      return fullSelection(extensionIds, "PR comparison base is not an ancestor of tested HEAD");
    }
    const fields = git(["diff", "--name-status", "--no-renames", "-z", base, "HEAD", "--"]).split(
      "\0",
    );
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
    return fullSelection(extensionIds, "PR diff or direct-import inventory unavailable");
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
