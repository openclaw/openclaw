import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, it } from "vitest";
import { resolveNpmJsonEntries } from "../../../scripts/lib/npm-json-output.mts";
import { resolveNpmRunner } from "../../../scripts/npm-runner.mts";
import { createNodeEvalArgs } from "../../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isRecord } from "../../normalization-core/src/record-coerce.js";

type CommandResult = { stdout: string; stderr: string };
type PackageManifest = {
  name: string;
  exports: Record<string, unknown>;
};

const COMMAND_TIMEOUT_MS = 180_000;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const names = (list: string) => list.trim().split(/\s+/u);

const compatibility = {
  "@openclaw/ai/provider-types": {
    values: ["PROVIDER_CONTEXT_HANDOFF", "PROVIDER_MODEL_INPUT", "resolveProviderContext"],
    types: names(`MediaContent ModelInputContent ProviderContext ProviderContextHandoff
      ProviderMessage ProviderModel ProviderStreamFunction ProviderStreamOptions
      ProviderUserMessage VideoContent`),
  },
  "@openclaw/ai/providers": {
    values: names(`BUILT_IN_API_PROVIDER_SOURCE_ID registerBuiltInApiProviders resetApiProviders
      OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH clampOpenAIPromptCacheKey`),
    types: [],
  },
  "@openclaw/ai/internal/anthropic": {
    values: names(`streamAnthropic streamSimpleAnthropic usesFoundryBearerAuth
      omitFoundryBearerCredentialHeaders requiresClaudeDefaultSampling
      requiresClaudeMandatoryAdaptiveThinking resolveClaudeFable5ModelIdentity
      resolveClaudeModelIdentity resolveClaudeMythos5ModelIdentity resolveClaudeNativeThinkingLevelMap
      resolveClaudeOpus5ModelIdentity resolveClaudeSonnet5ModelIdentity supportsClaudeAdaptiveThinking
      supportsClaudeNativeMaxEffort supportsClaudeNativeXhighEffort usesClaudeFable5MessagesContract
      usesClaudeStreamingRefusalContract requiresClaudeAdaptiveThinking defaultsClaudeAdaptiveThinking
      prepareClaudeNoPrefillRequestContext applyClaudeRequestContract resolveModelBoundThinkingReplayMode
      applyAnthropicRefusal ANTHROPIC_SERVER_SIDE_FALLBACK_BETA ANTHROPIC_SERVER_SIDE_FALLBACKS
      CLAUDE_OPUS_FALLBACK_MODEL_COST resolveAnthropicFallbackServingModelCost readAnthropicFallbackBoundary
      applyAnthropicFallbackBoundary ANTHROPIC_OMITTED_REASONING_TEXT findActiveAnthropicToolTurnAssistantIndex
      projectAnthropicTools reconcileAnthropicToolChoice resolveOriginalAnthropicToolName
      readAnthropicUsageTokenCount readAnthropicCacheWriteUsage readAnthropicPromptUsageSnapshot
      readLastAnthropicIterationUsage`),
    types:
      names(`AnthropicEffort AnthropicThinkingDisplay AnthropicOptions AnthropicFallbackBoundary
      AnthropicToolProjection AnthropicProjectedToolChoice AnthropicCacheWriteUsage
      AnthropicPromptUsageSnapshot AnthropicIterationUsageSnapshot AnthropicIterationUsageResult`),
  },
  "@openclaw/ai/internal/model-request-body": {
    values: [
      "encodedModelRequestBodyStream",
      "modelRequestBodyState",
      "prepareModelRequestBody",
      "serializeModelRequestBody",
    ],
    types: ["EncodedModelRequestBody"],
  },
  "@openclaw/ai/internal/openai": {
    values: names(`streamOpenAICompletions streamSimpleOpenAICompletions convertMessages
      parseAzureDeploymentNameMap resolveAzureDeploymentNameFromMap isTraditionalAzureOpenAIHost
      isOpenAICompatibleAzureResponsesBaseUrl OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH clampOpenAIPromptCacheKey
      isOpenAIGpt54MiniModel isOpenAIGpt55Model isOpenAIGpt56Model normalizeOpenAIReasoningEffort
      resolveOpenAISupportedReasoningEfforts supportsOpenAITemperature supportsOpenAIReasoningEffort
      resolveOpenAIReasoningEffortForModel streamOpenAIResponses streamSimpleOpenAIResponses
      OPENAI_RESPONSES_OUTPUT_TEXT_CONTENT_PART_TYPE AZURE_RESPONSES_TEXT_CONTENT_PART_TYPE
      OPENAI_RESPONSES_OUTPUT_TEXT_DELTA_EVENT_TYPE AZURE_RESPONSES_TEXT_DELTA_EVENT_TYPE
      isResponsesTextContentPartType isResponsesTextDeltaEventType isAzureResponsesTextDeltaEventType
      isAzureResponsesTextDeltaEvent resolveResponsesMessageSnapshotCollapse mapResponsesTerminalUsage
      readResponsesReasoningTokens resolveResponsesTerminalStopReason readResponsesToolCallItemIdentity
      createResponsesToolCallTracker mapOpenAIStopReason projectOpenAITools
      reconcileOpenAIResponsesToolChoice reconcileOpenAICompletionsToolChoice responsesPromptObserver
      encodedModelRequestBodyStream modelRequestBodyState`),
    types:
      names(`OpenAICompletionsOptions OpenAIReasoningEffort OpenAIApiReasoningEffort OpenAIResponsesOptions
      ResponsesTextContentPartType ResponsesTextDeltaEventType AzureResponsesTextContentPart
      AzureResponsesTextDeltaEvent ResponsesMessageSnapshotCollapse ResponsesTerminalUsagePayload
      ResponsesToolCallIdentity ResponsesToolCallState OpenAIStopReasonResult OpenAIToolProjection
      OpenAICompletionsToolChoice ResponsesPromptObservation`),
  },
  "@openclaw/ai/internal/tool-schema": {
    values:
      names(`extractToolSchemaModelCompat resolveUnsupportedToolSchemaKeywords shouldOmitEmptyArrayItems
      normalizeToolParameterSchema GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS cleanSchemaForGemini
      LLAMACPP_GBNF_MAX_REPETITION_THRESHOLD cleanSchemaForLlamacppGbnf findLlamacppGbnfSchemaViolations
      findOpenAIStrictSchemaViolations normalizeOpenAIStrictCompatSchema normalizeStrictOpenAIJsonSchema
      normalizeOpenAIStrictToolParameters isStrictOpenAIJsonSchemaCompatible findOpenAIStrictToolProjectionDiagnostics
      resolveOpenAIProjectedToolsStrictToolFlag stripUnsupportedSchemaKeywords projectRuntimeToolInputSchema
      publishRuntimeToolInputSchema getPublishedRuntimeToolInputSchema prepareOpenAIFunctionTool prepareAnthropicInputSchema`),
    types: names(`ToolSchemaModelCompat ToolParameterSchemaOptions RuntimeToolInputSchemaJson
      RuntimeToolInputSchemaProjection`),
  },
} as const;

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string } & Pick<
    SpawnOptionsWithoutStdio,
    "env" | "shell" | "windowsVerbatimArguments"
  >,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env ?? process.env,
      shell: options.shell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: options.windowsVerbatimArguments,
    });
    const timer = setTimeout(() => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
      reject(new Error(`command timed out: ${[command, ...args].join(" ")}`));
    }, COMMAND_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const result = { stdout: stdout.join(""), stderr: stderr.join("") };
      if (code === 0) {
        resolve(result);
      } else {
        reject(
          new Error(
            `command failed (${String(code ?? signal)}): ${[command, ...args].join(" ")}\n` +
              `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
          ),
        );
      }
    });
  });
}

function runNpmCommand(args: string[], cwd: string): Promise<CommandResult> {
  const env = {
    ...process.env,
    CI: process.env.CI ?? "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  const runner = resolveNpmRunner({ env, npmArgs: args });
  return runCommand(runner.command, runner.args, {
    cwd,
    env: runner.env ?? env,
    shell: runner.shell,
    windowsVerbatimArguments: runner.windowsVerbatimArguments,
  });
}

function compatibilityTypeSource(): string {
  return Object.entries(compatibility)
    .flatMap(([specifier, inventory], index) => {
      const line = (kind: "value" | "type", exports: readonly string[]) =>
        `export ${kind === "type" ? "type " : ""}{ ${exports.map((name) => `${name} as ${kind}_${index}_${name}`).join(", ")} } from ${JSON.stringify(specifier)};`;
      const lines = [line("value", inventory.values)];
      if (inventory.types.length) {
        lines.push(line("type", inventory.types));
      }
      return lines;
    })
    .join("\n");
}

it("@openclaw/ai packed package installs externally and preserves every published compatibility export", async () => {
  const repoRoot = process.cwd();
  const packageRoot = path.join(repoRoot, "packages", "ai");
  const manifest = JSON.parse(
    await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as PackageManifest;
  const rootManifest = JSON.parse(
    await fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
  ) as { devDependencies?: Record<string, string> };
  const nodeTypesVersion = rootManifest.devDependencies?.["@types/node"];
  if (!nodeTypesVersion) {
    throw new Error("root package is missing the @types/node version used by package checks");
  }
  const tempDir = tempDirs.make("openclaw-ai-consumer-");
  const writeJson = (name: string, value: unknown) =>
    fs.writeFile(path.join(tempDir, name), JSON.stringify(value));

  // The E2E global setup owns the exact-head build. Rebuilding this shared
  // package here can delete modules beneath concurrently running Gateways.
  const pack = await runNpmCommand(
    ["pack", "--ignore-scripts", "--json", "--pack-destination", tempDir],
    packageRoot,
  );
  const [packResult] = resolveNpmJsonEntries(JSON.parse(pack.stdout));
  const filename = isRecord(packResult) ? packResult.filename : undefined;
  if (typeof filename !== "string" || !filename.endsWith(".tgz")) {
    throw new Error("npm pack did not return a tarball filename");
  }
  const tarball = path.join(tempDir, filename);
  if (!(await fs.stat(tarball)).isFile()) {
    throw new Error("npm pack did not create a tarball file");
  }

  await writeJson("package.json", { private: true, type: "module" });
  await runNpmCommand(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
      `@types/node@${nodeTypesVersion}`,
    ],
    tempDir,
  );

  const specifiers = Object.keys(manifest.exports).map((key) =>
    key === "." ? manifest.name : `${manifest.name}/${key.slice(2)}`,
  );
  const importScript = `
      const specifiers = ${JSON.stringify(specifiers)};
      await Promise.all(specifiers.map((specifier) => import(specifier)));
      const compatibility = ${JSON.stringify(compatibility)};
      for (const [specifier, inventory] of Object.entries(compatibility)) {
        const module = await import(specifier);
        const missing = inventory.values.filter((name) => !(name in module));
        if (missing.length > 0) {
          throw new Error(specifier + " missing runtime exports: " + missing.join(", "));
        }
      }
      const body = await import("@openclaw/ai/internal/model-request-body");
      const legacy = await import("@openclaw/ai/internal/openai");
      const options = {};
      let encodings = 0;
      legacy.modelRequestBodyState(options).encode = async (payload) => {
        encodings++;
        return body.serializeModelRequestBody(payload);
      };
      const prepared = await body.prepareModelRequestBody(options)({ stream: true, input: "hello" });
      if (encodings !== 1 || !legacy.modelRequestBodyState(options).enabled) {
        throw new Error("request-body option state was split across package entries");
      }
      if (legacy.encodedModelRequestBodyStream(prepared.body) !== true) {
        throw new Error("encoded request-body stream metadata was split across package entries");
      }
      if (await prepared.body.text() !== '{"stream":true,"input":"hello"}') {
        throw new Error("request-body encoding changed across package entries");
      }
    `;
  await runCommand(process.execPath, createNodeEvalArgs(importScript, { evalFlag: "-e" }), {
    cwd: tempDir,
  });

  await fs.writeFile(path.join(tempDir, "compatibility.ts"), compatibilityTypeSource());
  await writeJson("tsconfig.json", {
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      skipLibCheck: false,
      strict: true,
      target: "ES2023",
      types: ["node"],
    },
    files: ["compatibility.ts"],
  });
  await runCommand(
    process.execPath,
    ["scripts/run-tsgo.mjs", "-p", path.join(tempDir, "tsconfig.json")],
    { cwd: repoRoot },
  );
}, 300_000);
