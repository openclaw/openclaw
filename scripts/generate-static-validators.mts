import path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "oxfmt";
import type { XSchema } from "typebox/schema";
import {
  EvaluateInput,
  question,
  VendorResult,
} from "../extensions/typesafe/src/schema-definition.js";
import { ThemeJsonSchema } from "../src/agents/modes/interactive/theme/theme-schema.js";
import { ModelRegistryConfigSchema } from "../src/agents/sessions/model-registry-schema-definition.js";
import { PresenceLocationResultSchema } from "../src/gateway/server-methods/presence-location-schema.js";
import {
  ComputerActParamsSchema,
  ComputerActResultSchema,
  ComputerUseCapabilityDescriptorSchema,
  ScreenSnapshotParamsSchema,
  ScreenSnapshotResultSchema,
} from "../src/plugins/computer-use-schemas.js";
import { NodeWorkerComputerInputSchema } from "../src/worker/node-computer-schemas.js";
import { writeGeneratedOutput } from "./lib/generated-output-utils.mts";
import {
  compileStandaloneValidators,
  standaloneValidatorHeader,
} from "./lib/typebox-standalone.mts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets: Array<{
  outputBase: string;
  lintRules?: readonly string[];
  additionalLintRules?: readonly string[];
  entries: Array<{ name: string; schema: XSchema; type: string }>;
}> = [
  {
    outputBase: "src/agents/sessions/model-registry-validator.generated",
    entries: [
      {
        name: "isModelsConfig",
        schema: ModelRegistryConfigSchema,
        type: 'import("./model-registry-schema-definition.js").ModelsConfig',
      },
    ],
  },
  {
    outputBase: "src/agents/modes/interactive/theme/theme-validator.generated",
    lintRules: ["eslint/no-unused-vars", "eslint/prefer-const", "eslint/no-var"],
    entries: [
      {
        name: "isThemeJson",
        schema: ThemeJsonSchema,
        type: 'import("./theme-schema.js").ThemeJson',
      },
    ],
  },
  {
    outputBase: "src/plugins/computer-use-validators.generated",
    additionalLintRules: [
      "eslint/no-underscore-dangle",
      "eslint/curly",
      "eslint/no-param-reassign",
      "eslint/prefer-object-has-own",
      "unicorn/no-instanceof-builtins",
      "unicorn/no-array-sort",
      "typescript/prefer-for-of",
      "typescript/no-unnecessary-type-conversion",
      "typescript/prefer-includes",
      "typescript/require-array-sort-compare",
    ],
    entries: [
      {
        name: "validateComputerActParams",
        schema: ComputerActParamsSchema,
        type: 'import("./computer-use-schemas.js").ComputerActParams',
      },
      {
        name: "validateComputerActResult",
        schema: ComputerActResultSchema,
        type: 'import("./computer-use-schemas.js").ComputerActResult',
      },
      {
        name: "validateComputerUseCapabilityDescriptor",
        schema: ComputerUseCapabilityDescriptorSchema,
        type: 'import("./computer-use-schemas.js").ComputerUseCapabilityDescriptor',
      },
      {
        name: "validateScreenSnapshotParams",
        schema: ScreenSnapshotParamsSchema,
        type: 'import("./computer-use-schemas.js").ScreenSnapshotParams',
      },
      {
        name: "validateScreenSnapshotResult",
        schema: ScreenSnapshotResultSchema,
        type: 'import("./computer-use-schemas.js").ScreenSnapshotResult',
      },
    ],
  },
  {
    outputBase: "src/worker/node-computer-validator.generated",
    entries: [
      {
        name: "isNodeWorkerComputerInput",
        schema: NodeWorkerComputerInputSchema,
        type: 'import("./node-computer-schemas.js").NodeWorkerComputerInput',
      },
    ],
  },
  {
    outputBase: "src/gateway/server-methods/presence-location-validator.generated",
    entries: [
      {
        name: "validatePresenceLocationResult",
        schema: PresenceLocationResultSchema,
        type: 'import("./presence-location-schema.js").PresenceLocationResult',
      },
    ],
  },
  {
    outputBase: "extensions/typesafe/src/schema-validator.generated",
    entries: [
      {
        name: "isEvaluationInput",
        schema: EvaluateInput,
        type: 'import("./schema-definition.js").EvaluationInput',
      },
      {
        name: "isEvaluation",
        schema: VendorResult,
        type: 'import("./schema-definition.js").Evaluation',
      },
      {
        name: "isEvaluationQuestion",
        schema: question,
        type: 'import("./schema-definition.js").EvaluationInput["questions"][string]',
      },
    ],
  },
];

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--check")) {
  throw new Error("Usage: pnpm static:validators:gen [--check]");
}
const check = args.includes("--check");
for (const { outputBase, entries, lintRules, additionalLintRules } of targets) {
  const runtime = await compileStandaloneValidators(entries, { resolveDir: repoRoot });
  const declaration = entries
    .map(({ name, type }) => `export function ${name}(value: unknown): value is ${type};`)
    .join("\n");
  for (const [extension, content] of [
    ["js", runtime],
    ["d.ts", declaration],
  ]) {
    const outputPath = `${outputBase}.${extension}`;
    const header = standaloneValidatorHeader("pnpm static:validators:gen", {
      declaration: extension === "d.ts",
      lintRules,
      additionalLintRules,
    });
    const formatted = await format(outputPath, header + content);
    if (formatted.errors.length > 0) {
      throw new Error(`Cannot format ${outputPath}: ${JSON.stringify(formatted.errors)}`);
    }
    const result = writeGeneratedOutput({ check, next: formatted.code, outputPath, repoRoot });
    if (check && result.changed) {
      throw new Error(`${outputPath} is stale; run pnpm static:validators:gen`);
    }
    console.log(`[static:validators] ${result.changed ? "updated" : "unchanged"} ${outputPath}`);
  }
}
