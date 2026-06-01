import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

type CommandLike = {
  command(name: string): CommandLike;
  description(value: string): CommandLike;
  option(
    flags: string,
    description: string,
    defaultValueOrParser?: string | ((value: string, previous?: string[]) => string[]),
    defaultValue?: string[],
  ): CommandLike;
  action<TOptions>(fn: (options: TOptions) => void | Promise<void>): CommandLike;
};

type SecretRef = {
  source: "exec";
  provider: string;
  id: string;
};

type SecretsPlanTarget = {
  type: "models.providers.apiKey";
  path: string;
  pathSegments: string[];
  providerId: string;
  ref: SecretRef;
};

type VaultExecProviderConfig = {
  source: "exec";
  pluginIntegration: {
    pluginId: "vault";
    integrationId: "vault";
  };
};

type ProviderSecretMapping = {
  providerId: string;
  secretId: string;
};

type SecretsApplyPlan = {
  version: 1;
  protocolVersion: 1;
  generatedAt: string;
  generatedBy: "manual";
  providerUpserts: Record<string, VaultExecProviderConfig>;
  targets: SecretsPlanTarget[];
};

type RegisterVaultCommandsParams = {
  program: CommandLike;
  config: OpenClawConfig;
};

type StatusOptions = {
  json?: boolean;
};

type SetupOptions = {
  planOut?: string;
  providerAlias?: string;
  openaiId?: string;
  anthropicId?: string;
  openrouterId?: string;
  providerKey?: string[];
};

type ProviderStatus = {
  configured: boolean;
  source?: string;
  command?: string;
  pluginIntegration?: {
    pluginId: string;
    integrationId: string;
  };
};

const VAULT_PROVIDER_ALIAS = "vault";
const SECRET_PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MODEL_PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EXEC_SECRET_REF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/;

function writeLine(message = ""): void {
  process.stdout.write(`${message}\n`);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assertValidProviderAlias(value: string): void {
  if (!SECRET_PROVIDER_ALIAS_PATTERN.test(value)) {
    throw new Error(
      `Invalid provider alias "${value}". Use lowercase letters, numbers, underscores, or hyphens.`,
    );
  }
}

function assertValidModelProviderId(label: string, value: string): void {
  if (!MODEL_PROVIDER_ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${label} model provider id: ${value}`);
  }
}

function assertValidVaultSecretId(label: string, value: string): void {
  if (
    !EXEC_SECRET_REF_ID_PATTERN.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error(`Invalid ${label} Vault secret id: ${value}`);
  }
}

function readProviderStatus(config: OpenClawConfig, providerAlias: string): ProviderStatus {
  const provider = config.secrets?.providers?.[providerAlias];
  if (!isRecord(provider)) {
    return { configured: false };
  }
  const base = {
    configured: true,
    source: normalizeOptionalString(provider.source),
  };
  if (provider.source !== "exec") {
    return base;
  }
  if ("pluginIntegration" in provider) {
    return {
      ...base,
      pluginIntegration: provider.pluginIntegration,
    };
  }
  return {
    ...base,
    command: normalizeOptionalString(provider.command),
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolverScriptPathCandidates(baseUrl: string): string[] {
  return [
    fileURLToPath(new URL("../vault-secret-ref-resolver.js", baseUrl)),
    fileURLToPath(new URL("./extensions/vault/vault-secret-ref-resolver.js", baseUrl)),
  ];
}

async function resolveResolverScriptPath(
  baseUrl = import.meta.url,
  exists: (filePath: string) => Promise<boolean> = pathExists,
): Promise<string> {
  const candidates = resolverScriptPathCandidates(baseUrl);
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

function buildProviderConfig(): VaultExecProviderConfig {
  return {
    source: "exec",
    pluginIntegration: {
      pluginId: "vault",
      integrationId: "vault",
    },
  };
}

function createModelApiKeyTarget(params: {
  providerAlias: string;
  providerId: string;
  secretId: string;
}): SecretsPlanTarget {
  assertValidModelProviderId("target", params.providerId);
  return {
    type: "models.providers.apiKey",
    path: `models.providers.${params.providerId}.apiKey`,
    pathSegments: ["models", "providers", params.providerId, "apiKey"],
    providerId: params.providerId,
    ref: {
      source: "exec",
      provider: params.providerAlias,
      id: params.secretId,
    },
  };
}

function parseProviderKeyMappings(values: string[] | undefined): ProviderSecretMapping[] {
  return (values ?? []).map((value) => {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(
        `Invalid --provider-key value "${value}". Use <model-provider-id>=<vault-secret-id>.`,
      );
    }
    const providerId = value.slice(0, separator).trim();
    const secretId = value.slice(separator + 1).trim();
    assertValidModelProviderId("--provider-key", providerId);
    assertValidVaultSecretId(`--provider-key ${providerId}`, secretId);
    return { providerId, secretId };
  });
}

function collectProviderSecrets(options: {
  openaiId?: string;
  anthropicId?: string;
  openrouterId?: string;
  providerKey?: string[];
}): ProviderSecretMapping[] {
  const providerSecrets: ProviderSecretMapping[] = [];
  if (options.openaiId) {
    providerSecrets.push({ providerId: "openai", secretId: options.openaiId });
  }
  if (options.anthropicId) {
    providerSecrets.push({ providerId: "anthropic", secretId: options.anthropicId });
  }
  if (options.openrouterId) {
    providerSecrets.push({ providerId: "openrouter", secretId: options.openrouterId });
  }
  providerSecrets.push(...parseProviderKeyMappings(options.providerKey));

  const seen = new Set<string>();
  for (const entry of providerSecrets) {
    const normalized = entry.providerId.toLowerCase();
    if (seen.has(normalized)) {
      throw new Error(`Duplicate model provider id in Vault setup: ${entry.providerId}`);
    }
    seen.add(normalized);
  }
  return providerSecrets;
}

function buildPlan(params: {
  providerAlias: string;
  providerConfig: VaultExecProviderConfig;
  providerSecrets: ProviderSecretMapping[];
}): SecretsApplyPlan {
  return {
    version: 1,
    protocolVersion: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: "manual",
    providerUpserts: {
      [params.providerAlias]: params.providerConfig,
    },
    targets: params.providerSecrets.map((entry) =>
      createModelApiKeyTarget({
        providerAlias: params.providerAlias,
        providerId: entry.providerId,
        secretId: entry.secretId,
      }),
    ),
  };
}

async function promptOptionalSecretId(label: string): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return normalizeOptionalString(await rl.question(`${label} Vault secret id (blank to skip): `));
  } finally {
    rl.close();
  }
}

async function promptProviderSecrets(options: SetupOptions): Promise<ProviderSecretMapping[]> {
  const openaiId =
    normalizeOptionalString(options.openaiId) ?? (await promptOptionalSecretId("OpenAI"));
  const anthropicId =
    normalizeOptionalString(options.anthropicId) ?? (await promptOptionalSecretId("Anthropic"));
  const openrouterId =
    normalizeOptionalString(options.openrouterId) ?? (await promptOptionalSecretId("OpenRouter"));
  if (openaiId) {
    assertValidVaultSecretId("OpenAI", openaiId);
  }
  if (anthropicId) {
    assertValidVaultSecretId("Anthropic", anthropicId);
  }
  if (openrouterId) {
    assertValidVaultSecretId("OpenRouter", openrouterId);
  }
  return collectProviderSecrets({
    ...(openaiId ? { openaiId } : {}),
    ...(anthropicId ? { anthropicId } : {}),
    ...(openrouterId ? { openrouterId } : {}),
    providerKey: options.providerKey,
  });
}

async function runStatus(config: OpenClawConfig, options: StatusOptions): Promise<void> {
  const provider = readProviderStatus(config, VAULT_PROVIDER_ALIAS);
  const authMethod = normalizeOptionalString(process.env.OPENCLAW_VAULT_AUTH_METHOD) ?? "token";
  const result = {
    providerAlias: VAULT_PROVIDER_ALIAS,
    provider,
    resolverScript: await resolveResolverScriptPath(),
    vaultAddr: normalizeOptionalString(process.env.VAULT_ADDR),
    authMethod,
    authMount:
      normalizeOptionalString(process.env.OPENCLAW_VAULT_AUTH_MOUNT) ??
      (authMethod === "kubernetes" ? "kubernetes" : "jwt"),
    authRole: normalizeOptionalString(process.env.OPENCLAW_VAULT_AUTH_ROLE),
    hasJwtFile: Boolean(normalizeOptionalString(process.env.OPENCLAW_VAULT_JWT_FILE)),
    hasVaultTokenFile: Boolean(normalizeOptionalString(process.env.VAULT_TOKEN_FILE)),
    kvMount: normalizeOptionalString(process.env.OPENCLAW_VAULT_KV_MOUNT) ?? "secret",
    kvVersion: normalizeOptionalString(process.env.OPENCLAW_VAULT_KV_VERSION) ?? "2",
    hasVaultToken: Boolean(normalizeOptionalString(process.env.VAULT_TOKEN)),
  };
  if (options.json) {
    writeJson(result);
    return;
  }
  writeLine(`Vault provider: ${provider.configured ? "configured" : "not configured"}`);
  if (provider.source) {
    writeLine(`Source: ${provider.source}`);
  }
  if (provider.command) {
    writeLine(`Command: ${provider.command}`);
  }
  if (provider.pluginIntegration) {
    writeLine(
      `Plugin integration: ${provider.pluginIntegration.pluginId}:${provider.pluginIntegration.integrationId}`,
    );
  }
  writeLine(`Resolver: ${result.resolverScript}`);
  writeLine(`VAULT_ADDR: ${result.vaultAddr ?? "not set"}`);
  writeLine(`Auth method: ${result.authMethod}`);
  writeLine(`VAULT_TOKEN: ${result.hasVaultToken ? "set" : "not set"}`);
  writeLine(`VAULT_TOKEN_FILE: ${result.hasVaultTokenFile ? "set" : "not set"}`);
  writeLine(`Auth mount: ${result.authMount}`);
  writeLine(`Auth role: ${result.authRole ?? "not set"}`);
  writeLine(`OPENCLAW_VAULT_JWT_FILE: ${result.hasJwtFile ? "set" : "not set"}`);
  writeLine(`KV mount: ${result.kvMount}`);
  writeLine(`KV version: ${result.kvVersion}`);
}

async function runSetup(options: SetupOptions): Promise<void> {
  const providerAlias = normalizeOptionalString(options.providerAlias) ?? VAULT_PROVIDER_ALIAS;
  assertValidProviderAlias(providerAlias);
  const providerSecrets = await promptProviderSecrets(options);
  const plan = buildPlan({
    providerAlias,
    providerConfig: buildProviderConfig(),
    providerSecrets,
  });
  const planPath =
    normalizeOptionalString(options.planOut) ??
    path.join(resolvePreferredOpenClawTmpDir(), `openclaw-vault-secrets-${process.pid}.json`);
  await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  writeLine(`Plan written to ${planPath}`);
  writeLine(`Targets: ${plan.targets.length}`);
  writeLine("");
  writeLine("Next steps:");
  writeLine(`  openclaw secrets apply --from ${planPath} --dry-run --allow-exec`);
  writeLine(`  openclaw secrets apply --from ${planPath} --allow-exec`);
  writeLine("  openclaw secrets audit --check --allow-exec");
  writeLine("  openclaw secrets reload");
}

export function registerVaultCommands(params: RegisterVaultCommandsParams): void {
  const vault = params.program.command("vault").description("Manage Vault SecretRefs");
  vault
    .command("status")
    .description("Show Vault SecretRef provider status")
    .option("--json", "Print JSON status")
    .action((options: StatusOptions) => runStatus(params.config, options));
  vault
    .command("setup")
    .description("Create a Vault SecretRef setup plan")
    .option("--plan-out <path>", "Write the generated secrets apply plan to a path")
    .option("--provider-alias <alias>", "Secret provider alias to configure", VAULT_PROVIDER_ALIAS)
    .option("--openai-id <id>", "Vault secret id for models.providers.openai.apiKey")
    .option("--anthropic-id <id>", "Vault secret id for models.providers.anthropic.apiKey")
    .option("--openrouter-id <id>", "Vault secret id for models.providers.openrouter.apiKey")
    .option(
      "--provider-key <provider=id>",
      "Vault secret id for any models.providers.<provider>.apiKey target",
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .action((options: SetupOptions) => runSetup(options));
}

export const testing = {
  buildPlan,
  buildProviderConfig,
  collectProviderSecrets,
  createModelApiKeyTarget,
  parseProviderKeyMappings,
  resolveResolverScriptPath,
  resolverScriptPathCandidates,
};
