import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format } from "oxfmt";
import { createCodexValidationSchemas } from "../extensions/codex/src/app-server/protocol-validator-schemas.js";
import { writeGeneratedOutput } from "./lib/generated-output-utils.mts";
import {
  compileStandaloneValidators,
  standaloneValidatorHeader,
} from "./lib/typebox-standalone.mts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputBase = "extensions/codex/src/app-server/protocol-validators.generated";
const command = "pnpm codex-app-server:validators:gen";

export async function generateCodexValidators(options: { check?: boolean } = {}): Promise<void> {
  const { context, schemas } = createCodexValidationSchemas();
  const entries = Object.entries(schemas).map(([name, schema]) => ({
    name: `is${name}`,
    schema,
    context,
  }));
  const runtime = await compileStandaloneValidators(entries, { resolveDir: repoRoot });
  const declarations = Object.keys(schemas)
    .map(
      (name) =>
        `export function is${name}(value: unknown): value is import("./protocol.js").${name};`,
    )
    .join("\n");
  const outputs: Array<[extension: string, source: string]> = [
    [
      "js",
      standaloneValidatorHeader(command, { additionalLintRules: ["eslint/no-param-reassign"] }) +
        runtime,
    ],
    ["d.ts", standaloneValidatorHeader(command, { declaration: true }) + declarations],
    ["json", JSON.stringify({ context, schemas })],
  ];
  for (const [extension, source] of outputs) {
    const outputPath = `${outputBase}.${extension}`;
    const formatted = await format(outputPath, source);
    if (formatted.errors.length > 0) {
      throw new Error(`Cannot format ${outputPath}: ${JSON.stringify(formatted.errors)}`);
    }
    const output = writeGeneratedOutput({
      check: options.check === true,
      next: formatted.code,
      outputPath,
      repoRoot,
    });
    if (options.check && output.changed) {
      throw new Error(`${outputPath} is stale; run pnpm codex-app-server:validators:gen`);
    }
    console.log(`[codex:validators] ${output.changed ? "updated" : "unchanged"} ${outputPath}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) {
    throw new Error("Usage: pnpm codex-app-server:validators:gen [--check]");
  }
  await generateCodexValidators({ check: args.includes("--check") });
}
