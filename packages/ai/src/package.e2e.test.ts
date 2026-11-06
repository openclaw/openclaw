import type { SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, it } from "vitest";
import { runManagedCommand } from "../../../scripts/lib/managed-child-process.mts";
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
} as const;

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; shell?: boolean } & Pick<
    SpawnOptionsWithoutStdio,
    "env" | "windowsVerbatimArguments"
  >,
): Promise<CommandResult> {
  const result = { stdout: "", stderr: "" };
  const code = await runManagedCommand({
    bin: command,
    args,
    ...options,
    shell: options.shell ?? false,
    timeoutMs: COMMAND_TIMEOUT_MS,
    timeoutKillGraceMs: 0,
    onReady(child) {
      child.stdout?.setEncoding("utf8").on("data", (chunk) => {
        result.stdout += chunk;
      });
      child.stderr?.setEncoding("utf8").on("data", (chunk) => {
        result.stderr += chunk;
      });
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (code !== 0) {
    throw new Error(
      `command failed (${code}): ${[command, ...args].join(" ")}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
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

function compatibilityTypeSource(specifiers: string[]): string {
  return [
    ...specifiers.map(
      (specifier, index) => `export * as entry_${index} from ${JSON.stringify(specifier)};`,
    ),
    ...Object.entries(compatibility).map(
      ([specifier, { values, types }]) =>
        `export { ${[...values, ...types.map((name) => `type ${name}`)].join(", ")} } from ${JSON.stringify(specifier)};`,
    ),
  ].join("\n");
}

it("@openclaw/ai packed package installs externally with public exports and shared entry state", async () => {
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
  await writeJson("package.json", { private: true, type: "module" });
  await runNpmCommand(
    ["install", "--ignore-scripts", tarball, `@types/node@${nodeTypesVersion}`],
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
      if (await new Response(prepared.body).text() !== '{"stream":true,"input":"hello"}') {
        throw new Error("request-body encoding changed across package entries");
      }
    `;
  await runCommand(process.execPath, createNodeEvalArgs(importScript, { evalFlag: "-e" }), {
    cwd: tempDir,
  });

  await fs.writeFile(path.join(tempDir, "compatibility.ts"), compatibilityTypeSource(specifiers));
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
