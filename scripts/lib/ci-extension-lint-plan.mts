import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript/unstable/ast";
import { resolveImportGraphDependents } from "../test-projects.test-support.mts";
import { listAvailableExtensionIds } from "./changed-extensions.mts";
import { createNativeTypeScriptParser } from "./native-typescript.mts";

/** Select reported packages; the lint runner retains the complete typed program. */
export async function resolveCiExtensionLintSelection(
  changedFiles: readonly string[],
  cwd = process.cwd(),
  { forceFull = false, baseRef }: { forceFull?: boolean; baseRef?: string } = {},
) {
  const available = new Set(listAvailableExtensionIds(cwd).map((id) => `extensions/${id}`));
  const reasons: Record<string, string[]> = {};
  const fullReasons: string[] = [];
  const rootFor = (file: string) => {
    const root = file.match(/^extensions\/[^/]+\//u)?.[0].slice(0, -1);
    return root && available.has(root) ? root : undefined;
  };
  const select = (root: string, reason: string) => {
    const entries = (reasons[root] ??= []);
    if (!entries.includes(reason)) {
      entries.push(reason);
    }
  };
  const sources: string[] = [];
  if (forceFull) {
    fullReasons.push("OPENCLAW_CI_EXTENSION_LINT_FULL");
  }
  for (const file of [...new Set(changedFiles)].toSorted()) {
    if (path.isAbsolute(file) || file.split("/").some((part) => part === ".." || !part)) {
      throw new Error(`Invalid changed extension lint path: ${file}`);
    }
    const root = rootFor(file);
    if (root) {
      select(root, `changed: ${file}`);
    }
    // These inputs can change type discovery or rules without a source import edge.
    if (
      /(^|\/)tsconfig[^/]*\.json$/u.test(file) ||
      /(^|\/)\.oxlintrc(?:\.json)?$/u.test(file) ||
      ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"].includes(file) ||
      file.startsWith("config/oxlint/") ||
      file.startsWith("config/tsconfig/") ||
      file.startsWith("patches/") ||
      file.startsWith(".github/actions/setup-node-env/") ||
      file.startsWith(".github/actions/setup-pnpm-store-cache/") ||
      /^scripts\/(?:run-oxlint|oxlint|check-changed|ci-check-plan|changed-lanes)(?:[./-]|$)/u.test(
        file,
      ) ||
      /^scripts\/lib\/(?:oxlint|ci-extension-lint|local-oxlint|extension-import|native-typescript)/u.test(
        file,
      ) ||
      [
        "scripts/lib/local-check-runtime.mts",
        "scripts/generate-kysely-types.mts",
        "scripts/prepare-extension-package-boundary-artifacts.mts",
        "scripts/test-projects.test-support.mts",
        ".github/workflows/ci.yml",
        "scripts/ci-build-manifest.mjs",
        "scripts/ci-static-step.sh",
        "scripts/lib/plugin-sdk-entrypoints.json",
        "scripts/lib/plugin-sdk-private-local-only-subpaths.json",
        "src/state/openclaw-state-schema.sql",
        "src/state/openclaw-agent-schema.sql",
      ].includes(file) ||
      path.basename(file) === "package.json"
    ) {
      fullReasons.push(`lint or type policy: ${file}`);
      continue;
    }
    if (file.startsWith("extensions/") && !root) {
      fullReasons.push(`shared extension input: ${file}`);
      continue;
    }
    if (/\.[cm]?[jt]sx?$/u.test(file)) {
      if (!existsSync(path.join(cwd, file))) {
        // Previous bytes may contain an ambient declaration; no safe graph-only projection.
        fullReasons.push(`removed source: ${file}`);
      } else {
        sources.push(file);
      }
    }
  }
  if (!fullReasons.length && sources.length) {
    const previousSources: { fileName: string; text: string }[] = [];
    try {
      if (!baseRef || !/^[a-f0-9]{40}$/u.test(baseRef)) {
        throw new Error("Missing exact base revision");
      }
      const git = (args: string[]) =>
        execFileSync("git", args, {
          cwd,
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        });
      if (git(["rev-parse", "--verify", `${baseRef}^{commit}`]).trim() !== baseRef) {
        throw new Error("Unavailable exact base revision");
      }
      const priorFiles = new Set(
        git(["ls-tree", "-r", "--name-only", "-z", baseRef, "--", ...sources]).split("\0"),
      );
      for (const fileName of sources.filter((file) => priorFiles.has(file))) {
        previousSources.push({ fileName, text: git(["show", `${baseRef}:${fileName}`]) });
      }
    } catch {
      fullReasons.push("previous source types unavailable at the exact diff base");
    }
    const consumers = resolveImportGraphDependents(sources, cwd, {
      tooling: true,
      resolveAliases: true,
    });
    const executionOwners = new Set([
      "scripts/run-oxlint.mts",
      "scripts/run-oxlint-shards.mts",
      "scripts/prepare-extension-package-boundary-artifacts.mts",
      "scripts/oxlint-boundary-guards.mjs",
      "scripts/ci-check-plan.mts",
      "scripts/ci-build-manifest.mjs",
    ]);
    if (sources.some((file) => file.startsWith("scripts/"))) {
      for (const consumer of consumers.filter((file) => executionOwners.has(file))) {
        fullReasons.push(`lint execution consumer: ${consumer}`);
      }
    }
    const currentSources = [...sources, ...consumers].map((fileName) => ({
      fileName,
      text: readFileSync(path.join(cwd, fileName), "utf8"),
    }));
    // Class fields, module-local declarations and fixture strings are not global type inputs.
    using parser = createNativeTypeScriptParser({ cwd });
    // A broad SDK edit can reach thousands of files. Release each syntax batch
    // before decoding the next; a single global impact already requires full lint.
    ambientScan: for (const inputs of fullReasons.length ? [] : [previousSources, currentSources]) {
      for (let offset = 0; offset < inputs.length; offset += 32) {
        for (const source of parser.parseSourceFiles(inputs.slice(offset, offset + 32))) {
          let ambient = !source.externalModuleIndicator;
          const visit = (node: ts.Node) => {
            if (!ts.isModuleDeclaration(node)) {
              return;
            }
            if (
              ts.isStringLiteralLikeNode(node.name) ||
              (ts.isIdentifier(node.name) && node.name.text === "global")
            ) {
              ambient = true;
            }
            if (node.body) {
              if (ts.isModuleDeclaration(node.body)) {
                visit(node.body);
              } else {
                node.body.forEachChild(visit);
              }
            }
          };
          source.forEachChild(visit);
          if (ambient) {
            fullReasons.push(
              `ambient type impact: ${path.relative(cwd, source.fileName).split(path.sep).join("/")}`,
            );
            break ambientScan;
          }
        }
      }
    }
    for (const file of consumers) {
      const root = rootFor(file);
      if (root && !reasons[root]) {
        select(root, `import consumer: ${file}`);
      } else if (file.startsWith("extensions/") && !root) {
        fullReasons.push(`shared extension consumer: ${file}`);
      }
    }
  }
  return {
    mode: fullReasons.length ? ("full" as const) : ("selected" as const),
    extensionRoots: Object.keys(reasons).toSorted(),
    reasons,
    fullReasons,
  };
}
