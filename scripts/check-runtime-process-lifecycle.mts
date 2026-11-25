import { execFileSync, spawnSync } from "node:child_process";
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

function readSourceProjection(factory: ts.Block) {
  const helpers = factory.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations);
  const getHelper = (name: string) => {
    const helper = helpers.find(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
    )?.initializer;
    if (!helper || !ts.isArrowFunction(helper) || ts.isBlock(helper.body)) {
      throw new Error(`Expected a static ${name} helper in the core runtime manifest.`);
    }
    return { parameters: helper.parameters, body: unwrapExpression(helper.body) };
  };
  const core = getHelper("runtimeProcessEntrypoint");
  const projection = ts.isObjectLiteralExpression(core.body)
    ? core.body.properties
        .filter(ts.isPropertyAssignment)
        .find((property) => getPropertyNameText(property.name) === "sourceModulePath")?.initializer
    : undefined;
  if (
    !projection ||
    !ts.isTemplateExpression(projection) ||
    projection.templateSpans.length !== 2
  ) {
    throw new Error("Expected the core helper to project a literal source path and extension.");
  }
  const [modulePath, suffix] = projection.templateSpans;
  const extensionFallback = suffix!.expression;
  const defaultParameter = core.parameters[3]?.initializer;
  if (
    !ts.isIdentifier(modulePath!.expression) ||
    modulePath!.expression.text !== core.parameters[0]?.name.getText() ||
    !ts.isBinaryExpression(extensionFallback) ||
    extensionFallback.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
    !ts.isIdentifier(extensionFallback.left) ||
    extensionFallback.left.text !== core.parameters[3]?.name.getText() ||
    !ts.isStringLiteral(extensionFallback.right) ||
    (defaultParameter && !ts.isStringLiteral(defaultParameter))
  ) {
    throw new Error("Cannot read the core runtime helper's source path projection.");
  }
  const loaderFree = getHelper("loaderFreeEntrypoint");
  if (
    !ts.isCallExpression(loaderFree.body) ||
    !ts.isIdentifier(loaderFree.body.expression) ||
    loaderFree.body.expression.text !== "runtimeProcessEntrypoint"
  ) {
    throw new Error("Expected the loader-free helper to call the core runtime helper.");
  }
  const forwardedPath = loaderFree.body.arguments[0];
  const forwardedExtension = loaderFree.body.arguments[3];
  if (
    !forwardedPath ||
    !ts.isIdentifier(forwardedPath) ||
    forwardedPath.text !== loaderFree.parameters[0]?.name.getText() ||
    !forwardedExtension ||
    !ts.isStringLiteral(forwardedExtension)
  ) {
    throw new Error("Cannot read the loader-free runtime helper's source path projection.");
  }
  const defaultExtension = defaultParameter?.text ?? extensionFallback.right.text;
  return (helper: string, path: string, sourceExtension?: string) => {
    const extension =
      helper === "loaderFreeEntrypoint"
        ? forwardedExtension.text
        : (sourceExtension ?? defaultExtension);
    return (
      projection.head.text + path + modulePath!.literal.text + extension + suffix!.literal.text
    );
  };
}

function readCoreEntrypoints(source: ts.SourceFile) {
  const factory = source.statements
    .filter(ts.isFunctionDeclaration)
    .find((statement) => statement.name?.text === "createRuntimeProcessEntrypoints");
  const result = factory?.body?.statements.find(ts.isReturnStatement)?.expression;
  const entries = result && unwrapExpression(result);
  if (!factory?.body || !entries || !ts.isObjectLiteralExpression(entries)) {
    throw new Error("Expected a static core runtime entrypoint manifest.");
  }
  const sourcePath = readSourceProjection(factory.body);
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
    targets.set(name, sourcePath(helper.text, modulePath.text, extension?.text));
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

function lifecycleOwnerChanged(
  root: string,
  base: string,
  staged: boolean,
  owner: string,
): boolean {
  const result = spawnSync(
    "git",
    ["--literal-pathspecs", "diff", "--quiet", ...(staged ? ["--cached"] : []), base, "--", owner],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`Could not compare lifecycle owner ${owner} against ${base}.`);
  }
  return result.status === 1;
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
      const modes = Object.hasOwn(registry, name) ? registry[name]! : {};
      if ((retargeted || previousModes) && Object.keys(modes).length === 0) {
        failures.push(`${name} (${target}) needs a launch mode in ${registryPath}.`);
      }
      // A mode can retire while its entrypoint still serves other launchers.
      // Require the prior owner to change with that retirement.
      for (const [mode, { owner }] of Object.entries(previousModes ?? {})) {
        if (!Object.hasOwn(modes, mode) && !lifecycleOwnerChanged(root, base, args.staged, owner)) {
          failures.push(
            `${name}/${mode} was removed without changing its lifecycle owner ${owner}.`,
          );
        }
      }
      for (const [mode, { memory }] of Object.entries(modes)) {
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
