import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript/ast";
import { z } from "zod";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";
import { loadRatchetSources, parseRatchetArgs, resolveRatchetBase } from "./lib/shrink-ratchet.mts";
import { getPropertyNameText, unwrapExpression } from "./lib/ts-guard-utils.mts";

const manifestPath = "src/infra/runtime-process-manifest.ts";
const registryPath = "scripts/runtime-process-lifecycle.json";
const registrySchema = z.record(
  z.string(),
  z.record(
    z.string(),
    z.strictObject({
      owner: z.string().regex(/^src\/(?:[\w-]+\/)*[\w.-]+\.ts$/u),
      start: z.enum(["eager", "lazy"]),
      retire: z.string().trim().min(1),
      memory: z.strictObject({
        scope: z.enum(["process-rss", "worker-heap"]),
        expectedMiB: z.number().positive().nullable(),
      }),
    }),
  ),
);

function readCoreEntrypoints(source: ts.SourceFile) {
  const factory = source.statements
    .filter(ts.isFunctionDeclaration)
    .find((statement) => statement.name?.text === "createRuntimeProcessEntrypoints");
  const result = factory?.body?.statements.find(ts.isReturnStatement)?.expression;
  const entries = result && unwrapExpression(result);
  if (!entries || !ts.isObjectLiteralExpression(entries)) {
    throw new Error("Expected a static core runtime entrypoint manifest.");
  }
  const targets = new Map<string, string>();
  for (const property of entries.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isCallExpression(property.initializer)) {
      throw new Error("Expected a named runtime entrypoint with a literal source path.");
    }
    const name = getPropertyNameText(property.name);
    const { expression: helper, arguments: args } = property.initializer;
    const modulePath = args[0];
    const extension = args[3];
    if (
      !name ||
      targets.has(name) ||
      !ts.isIdentifier(helper) ||
      (helper.text !== "runtimeProcessEntrypoint" && helper.text !== "loaderFreeEntrypoint") ||
      !modulePath ||
      !ts.isStringLiteral(modulePath) ||
      (extension && !ts.isStringLiteral(extension))
    ) {
      throw new Error(
        `Cannot identify the source for core runtime entrypoint ${name ?? "<unnamed>"}.`,
      );
    }
    const sourceExtension =
      extension?.text ?? (helper.text === "loaderFreeEntrypoint" ? ".mjs" : ".ts");
    targets.set(name, `src/${modulePath.text}${sourceExtension}`);
  }
  return targets;
}

function containsGitFile(root: string, ref: string, file: string): boolean {
  return (
    execFileSync("git", ["ls-tree", "--name-only", ref, "--", file], {
      cwd: root,
      encoding: "utf8",
    }).trim() === file
  );
}

export function main(root = process.cwd(), argv = process.argv.slice(2)): number {
  try {
    const args = parseRatchetArgs(argv);
    const base = resolveRatchetBase(root, args);
    if (!base || args.prune) {
      throw new Error(
        "Runtime process lifecycle validation requires a Git base and has no prune mode.",
      );
    }
    const basePaths = containsGitFile(root, base, registryPath)
      ? [manifestPath, registryPath]
      : [manifestPath];
    const previous = loadRatchetSources(root, basePaths, base);
    const current = args.staged
      ? loadRatchetSources(root, [manifestPath, registryPath])
      : new Map(
          [manifestPath, registryPath].map((file) => [
            file,
            readFileSync(join(root, file), "utf8"),
          ]),
        );
    using parser = createNativeTypeScriptParser({ cwd: root });
    const [oldSource, newSource] = parser.parseSourceFiles([
      { fileName: "base-runtime-process-manifest.ts", text: previous.get(manifestPath)! },
      { fileName: manifestPath, text: current.get(manifestPath)! },
    ]);
    const before = readCoreEntrypoints(oldSource!);
    const after = readCoreEntrypoints(newSource!);
    const previousRegistry = registrySchema.parse(JSON.parse(previous.get(registryPath) ?? "{}"));
    const registry = registrySchema.parse(JSON.parse(current.get(registryPath)!));
    const stagedFiles = args.staged
      ? new Set(
          execFileSync("git", ["ls-files", "-z", "--", "src"], {
            cwd: root,
            encoding: "utf8",
            maxBuffer: 8 * 1024 * 1024,
          }).split("\0"),
        )
      : undefined;

    const failures: string[] = [];
    for (const [name, target] of after) {
      const retargeted = before.get(name) !== target;
      const previousModes = Object.hasOwn(previousRegistry, name) ? previousRegistry[name]! : null;
      const modes = Object.entries(Object.hasOwn(registry, name) ? registry[name]! : {});
      if ((retargeted || previousModes) && modes.length === 0) {
        failures.push(`${name} (${target}) needs a launch mode in ${registryPath}.`);
      }
      for (const [mode, { memory }] of modes) {
        const previouslyUnmeasured =
          previousModes &&
          Object.hasOwn(previousModes, mode) &&
          previousModes[mode]!.memory.expectedMiB === null;
        if (
          memory.expectedMiB === null &&
          (retargeted || (previousModes && !previouslyUnmeasured))
        ) {
          failures.push(`${name}/${mode} (${target}) needs an expected memory budget.`);
        }
      }
    }
    for (const [name, modes] of Object.entries(registry)) {
      if (!after.has(name) || Object.keys(modes).length === 0) {
        failures.push(
          `${name} must identify a current core entrypoint with at least one launch mode.`,
        );
      }
      for (const [mode, { owner }] of Object.entries(modes)) {
        if (!(stagedFiles?.has(owner) ?? existsSync(join(root, owner)))) {
          failures.push(`${name}/${mode} references a missing lifecycle owner: ${owner}.`);
        }
      }
    }
    if (failures.length > 0) {
      console.error(failures.join("\n"));
      return 1;
    }
    console.log(`Runtime process lifecycle declarations OK against ${base}.`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
