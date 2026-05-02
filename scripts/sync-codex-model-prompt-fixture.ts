import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PERSONALITY_PLACEHOLDER = "{{ personality }}";

export const CODEX_MODEL_PROMPT_FIXTURE_DIR =
  "test/fixtures/agents/prompt-snapshots/codex-model-catalog";

type JsonObject = Record<string, unknown>;
type CodexPromptPersonality = "default" | "friendly" | "pragmatic";

type CodexModelCatalogModel = {
  slug: string;
  base_instructions?: string;
  model_messages?: {
    instructions_template?: string;
    instructions_variables?: Partial<Record<`personality_${CodexPromptPersonality}`, string>>;
  } | null;
};

type CodexModelPromptFixture = {
  model: string;
  personality: CodexPromptPersonality;
  instructions: string;
  source: {
    catalogPath: string;
    catalogKind: "checked_in_catalog" | "models_cache" | "unknown";
    catalogGitHead?: string;
    field: string;
  };
};

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCodexModel(value: unknown): value is CodexModelCatalogModel {
  return isJsonObject(value) && typeof value.slug === "string";
}

function inferCatalogKind(catalogPath: string): CodexModelPromptFixture["source"]["catalogKind"] {
  if (path.basename(catalogPath) === "models_cache.json") {
    return "models_cache";
  }
  if (catalogPath.endsWith(path.join("models-manager", "models.json"))) {
    return "checked_in_catalog";
  }
  return "unknown";
}

function metadataCatalogPath(params: { catalogPath: string; catalogLabel?: string }): string {
  if (params.catalogLabel) {
    return params.catalogLabel;
  }
  if (path.basename(params.catalogPath) === "models_cache.json") {
    return "<codex-home>/models_cache.json";
  }
  if (params.catalogPath.endsWith(path.join("models-manager", "models.json"))) {
    return "<codex-checkout>/codex-rs/models-manager/models.json";
  }
  return params.catalogPath;
}

function readModelsFromCatalog(value: unknown): CodexModelCatalogModel[] {
  if (!isJsonObject(value) || !Array.isArray(value.models)) {
    throw new Error("Codex model catalog must contain a top-level models array.");
  }
  return value.models.filter(isCodexModel);
}

function personalityKey(
  personality: CodexPromptPersonality,
): `personality_${CodexPromptPersonality}` {
  return `personality_${personality}`;
}

export function renderCodexModelInstructions(params: {
  model: CodexModelCatalogModel;
  personality: CodexPromptPersonality;
}): { instructions: string; field: string } {
  const template = params.model.model_messages?.instructions_template;
  if (template) {
    const key = personalityKey(params.personality);
    const personalityMessage = params.model.model_messages?.instructions_variables?.[key] ?? "";
    return {
      instructions: template.replaceAll(PERSONALITY_PLACEHOLDER, personalityMessage),
      field: `model_messages.instructions_template + model_messages.instructions_variables.${key}`,
    };
  }
  if (typeof params.model.base_instructions === "string") {
    return {
      instructions: params.model.base_instructions,
      field: "base_instructions",
    };
  }
  throw new Error(`Codex model ${params.model.slug} has no renderable instructions.`);
}

export async function createCodexModelPromptFixture(params: {
  catalogPath: string;
  catalogLabel?: string;
  model: string;
  personality: CodexPromptPersonality;
  catalogGitHead?: string;
}): Promise<CodexModelPromptFixture> {
  const catalogJson = JSON.parse(await fs.readFile(params.catalogPath, "utf8")) as unknown;
  const models = readModelsFromCatalog(catalogJson);
  const model = models.find((candidate) => candidate.slug === params.model);
  if (!model) {
    throw new Error(`Codex model ${params.model} was not found in ${params.catalogPath}.`);
  }
  const rendered = renderCodexModelInstructions({
    model,
    personality: params.personality,
  });
  return {
    model: params.model,
    personality: params.personality,
    instructions: rendered.instructions,
    source: {
      catalogPath: metadataCatalogPath({
        catalogPath: params.catalogPath,
        catalogLabel: params.catalogLabel,
      }),
      catalogKind: inferCatalogKind(params.catalogPath),
      catalogGitHead: params.catalogGitHead,
      field: rendered.field,
    },
  };
}

function parseArgValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function parsePersonality(value: string | undefined): CodexPromptPersonality {
  if (value === "default" || value === "friendly" || value === "pragmatic") {
    return value;
  }
  if (value) {
    throw new Error(`Unsupported Codex prompt personality: ${value}`);
  }
  return "pragmatic";
}

function defaultCatalogPath(): string {
  const localCodexCatalog = path.join(
    os.homedir(),
    "code",
    "codex",
    "codex-rs",
    "models-manager",
    "models.json",
  );
  return localCodexCatalog;
}

function fixtureBaseName(params: { model: string; personality: CodexPromptPersonality }): string {
  return `${params.model}.${params.personality}`;
}

async function writeFixture(params: { fixture: CodexModelPromptFixture; outputDir: string }) {
  await fs.mkdir(params.outputDir, { recursive: true });
  const baseName = fixtureBaseName(params.fixture);
  const promptPath = path.join(params.outputDir, `${baseName}.instructions.md`);
  const metadataPath = path.join(params.outputDir, `${baseName}.source.json`);
  await fs.writeFile(
    promptPath,
    params.fixture.instructions.endsWith("\n")
      ? params.fixture.instructions
      : `${params.fixture.instructions}\n`,
  );
  await fs.writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        model: params.fixture.model,
        personality: params.fixture.personality,
        source: params.fixture.source,
      },
      null,
      2,
    )}\n`,
  );
  return { promptPath, metadataPath };
}

async function run(argv = process.argv.slice(2)) {
  const catalogPath = path.resolve(parseArgValue(argv, "--catalog") ?? defaultCatalogPath());
  const model = parseArgValue(argv, "--model") ?? "gpt-5.5";
  const personality = parsePersonality(parseArgValue(argv, "--personality"));
  const catalogGitHead = parseArgValue(argv, "--catalog-git-head");
  const catalogLabel = parseArgValue(argv, "--source-label");
  const outputDir = path.resolve(
    repoRoot,
    parseArgValue(argv, "--out-dir") ?? CODEX_MODEL_PROMPT_FIXTURE_DIR,
  );
  const fixture = await createCodexModelPromptFixture({
    catalogPath,
    catalogLabel,
    model,
    personality,
    catalogGitHead,
  });
  const written = await writeFixture({ fixture, outputDir });
  console.log(
    `Wrote Codex ${model} ${personality} prompt fixture to ${path.relative(
      repoRoot,
      written.promptPath,
    )} and ${path.relative(repoRoot, written.metadataPath)}.`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  await run();
}
