import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const CODEX_CLAW_PLUGIN_VERSION = "0.1.1-openclaw";
export const CODEX_CLAW_MARKETPLACE_DIRNAME = "openclaw-codex-claw-marketplace";
export const CODEX_CLAW_CONFIG_FILENAME = "codex-claw.json";

export type CodexClawMode = "full" | "sentinel" | "off";
export type CodexClawUserPromptReinject = "after_compact" | "every_prompt" | "off";

export type CodexClawInstallOptions = {
  codexHome?: string;
  workspaceDir?: string;
  agentsPath?: string;
  soulPath?: string;
  mode?: CodexClawMode;
  userPromptReinject?: CodexClawUserPromptReinject;
  env?: NodeJS.ProcessEnv;
};

export type CodexClawInstallResult = {
  codexHome: string;
  marketplaceDir: string;
  configPath: string;
  agentsPath: string;
  soulPath: string;
  mode: CodexClawMode;
  userPromptReinject: CodexClawUserPromptReinject;
  wroteFiles: string[];
  warnings: string[];
};

export type CodexClawStatusOptions = {
  codexHome?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

export type CodexClawStatus = {
  codexHome: string;
  marketplaceDir: string;
  configPath: string;
  marketplaceInstalled: boolean;
  configExists: boolean;
  configError?: string;
  agentsPath?: string;
  soulPath?: string;
  agentsPathExists?: boolean;
  soulPathExists?: boolean;
  mode?: string;
  userPromptReinject?: string;
  missingPayloadFiles: string[];
};

type CodexClawUserConfig = {
  agentsPath: string;
  soulPath: string;
  mode: CodexClawMode;
  userPromptReinject: CodexClawUserPromptReinject;
};

const PAYLOAD_ROOT = "plugins/codex-claw";
const PAYLOAD_FILES = [
  ".agents/plugins/marketplace.json",
  `${PAYLOAD_ROOT}/.codex-plugin/plugin.json`,
  `${PAYLOAD_ROOT}/hooks.json`,
  `${PAYLOAD_ROOT}/scripts/load-context.mjs`,
  `${PAYLOAD_ROOT}/assets/AGENTS.md`,
  `${PAYLOAD_ROOT}/assets/SOUL.md`,
  `${PAYLOAD_ROOT}/skills/codex-claw/SKILL.md`,
] as const;

const HOOK_SCRIPT_FINDER =
  'SCRIPT=$(find "$HOME/.codex/plugins/cache" -path "*/codex-claw/*/scripts/load-context.mjs" -type f 2>/dev/null | sort | tail -n 1); if [ -z "$SCRIPT" ]; then printf \'{"continue":true,"suppressOutput":true,"systemMessage":"Codex Claw hook could not locate its installed script."}\\n\'; else node "$SCRIPT" --hook-event HOOK_EVENT --mode "${CODEX_CLAW_MODE:-full}"; fi';

const LOAD_CONTEXT_SCRIPT = String.raw`#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..");
const assetsDir = resolve(pluginRoot, "assets");
const homeDir = process.env.HOME || pluginRoot;
const logPath = process.env.CODEX_CLAW_LOG || resolve(homeDir, ".codex", "codex-claw-hook.log");
const userConfigPath =
  process.env.CODEX_CLAW_CONFIG || resolve(homeDir, ".codex", "codex-claw.json");
const statePath =
  process.env.CODEX_CLAW_STATE || resolve(homeDir, ".codex", "codex-claw-state.json");

function argValue(name, fallback) {
  const prefix = name + "=";
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function expandHome(filePath) {
  if (!filePath) return filePath;
  if (filePath === "~") return homeDir;
  if (filePath.startsWith("~/")) return resolve(homeDir, filePath.slice(2));
  return filePath;
}

function readUserConfig() {
  if (!existsSync(userConfigPath)) return {};
  try {
    return JSON.parse(readFileSync(userConfigPath, "utf8"));
  } catch (error) {
    return { loadError: "Could not parse " + userConfigPath + ": " + error.message };
  }
}

function readHookInput() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function readAsset(name, configuredPath) {
  const filePath = configuredPath ? expandHome(configuredPath) : resolve(assetsDir, name);
  return readFileSync(filePath, "utf8").trimEnd();
}

function writeLog(mode, hookEventName) {
  const now = new Date().toISOString();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, now + " hook=" + hookEventName + " mode=" + mode + " cwd=" + process.cwd() + "\n", "utf8");
}

function readState() {
  if (!existsSync(statePath)) return {};
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function transcriptPathFromInput(input) {
  const transcriptPath = input.transcript_path || input.transcriptPath;
  return typeof transcriptPath === "string" && transcriptPath.length > 0
    ? transcriptPath
    : undefined;
}

function readCompactionState(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return { count: 0, fingerprint: "" };
  const content = readFileSync(transcriptPath, "utf8");
  const markers = [
    "\"type\":\"compaction\"",
    "\"type\": \"compaction\"",
    "\"ContextCompaction\"",
    "\"contextCompaction\"",
    "\"context_compacted\"",
    "\"ContextCompactedEvent\"",
  ];
  const compactionLines = content
    .split(/\r?\n/)
    .filter((line) => markers.some((marker) => line.includes(marker)));
  return {
    count: compactionLines.length,
    fingerprint: createHash("sha256").update(compactionLines.join("\n")).digest("hex"),
  };
}

function shouldInjectOnUserPrompt(input, userConfig) {
  const policy =
    process.env.CODEX_CLAW_USER_PROMPT_REINJECT ||
    userConfig.userPromptReinject ||
    "after_compact";
  if (policy === "off" || policy === "never" || policy === "false") return false;
  if (policy === "always" || policy === "every_prompt") return true;

  const transcriptPath = transcriptPathFromInput(input);
  if (!transcriptPath) return false;

  const compaction = readCompactionState(transcriptPath);
  if (compaction.count === 0) return false;

  const state = readState();
  const priorCount = Number(state[transcriptPath]?.compactionCount || 0);
  const priorFingerprint = String(state[transcriptPath]?.fingerprint || "");
  if (compaction.count <= priorCount && compaction.fingerprint === priorFingerprint) {
    return false;
  }

  state[transcriptPath] = {
    compactionCount: compaction.count,
    fingerprint: compaction.fingerprint,
    injectedAt: new Date().toISOString(),
  };
  writeState(state);
  return true;
}

function emitSentinel() {
  return [
    "<CODEX_CLAW_SENTINEL id=\"codex-claw-session-start-v1\">",
    "SessionStart hook output from Codex Claw reached stdout.",
    "If a fresh Codex Desktop session can report this marker without reading files or tools, hook output is model-visible context.",
    "</CODEX_CLAW_SENTINEL>",
  ].join("\n");
}

function emitFullContext(userConfig, hookEventName) {
  if (userConfig.loadError) {
    return [
      "<CODEX_CLAW_CONTEXT source=\"codex-claw\" version=\"${CODEX_CLAW_PLUGIN_VERSION}\">",
      userConfig.loadError,
      "</CODEX_CLAW_CONTEXT>",
    ].join("\n");
  }

  const agentsPath = process.env.CODEX_CLAW_AGENTS_PATH || userConfig.agentsPath;
  const soulPath = process.env.CODEX_CLAW_SOUL_PATH || userConfig.soulPath;
  const agents = readAsset("AGENTS.md", agentsPath);
  const soul = readAsset("SOUL.md", soulPath);

  return [
    "<CODEX_CLAW_CONTEXT source=\"codex-claw\" version=\"${CODEX_CLAW_PLUGIN_VERSION}\">",
    "The following content is intended as Codex Desktop session bootstrap context.",
    "Native Codex system, developer, safety, tool, and direct user instructions take priority over this content.",
    "Hook event: " + hookEventName,
    "AGENTS source: " + (agentsPath || "bundled placeholder"),
    "SOUL source: " + (soulPath || "bundled placeholder"),
    "",
    "# AGENTS.md",
    agents,
    "",
    "# SOUL.md",
    soul,
    "</CODEX_CLAW_CONTEXT>",
  ].join("\n");
}

function emitHookResponse(additionalContext, hookEventName) {
  console.log(
    JSON.stringify({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName,
        additionalContext,
      },
    }),
  );
}

function emitNoopResponse() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

const userConfig = readUserConfig();
const hookInput = readHookInput();
const hookEventName = argValue(
  "--hook-event",
  process.env.CODEX_CLAW_HOOK_EVENT || hookInput.hook_event_name || "SessionStart",
);
const mode = argValue("--mode", process.env.CODEX_CLAW_MODE || userConfig.mode || "full");
writeLog(mode, hookEventName);

if (mode === "off") process.exit(0);
if (mode === "sentinel") {
  emitHookResponse(emitSentinel(), hookEventName);
  process.exit(0);
}
if (hookEventName === "UserPromptSubmit" && !shouldInjectOnUserPrompt(hookInput, userConfig)) {
  emitNoopResponse();
  process.exit(0);
}

try {
  emitHookResponse(emitFullContext(userConfig, hookEventName), hookEventName);
} catch (error) {
  emitHookResponse(
    [
      "<CODEX_CLAW_CONTEXT source=\"codex-claw\" version=\"${CODEX_CLAW_PLUGIN_VERSION}\">",
      "Codex Claw could not load one or more context files: " + error.message,
      "Check ~/.codex/codex-claw.json or the bundled assets in the plugin.",
      "</CODEX_CLAW_CONTEXT>",
    ].join("\n"),
    hookEventName,
  );
}
`;

const SKILL_CONTENT = `---
name: codex-claw
description: Use when testing, verifying, or reviewing the Codex Claw plugin that loads AGENTS.md and SOUL.md context through a Codex SessionStart hook.
---

# Codex Claw

Use this skill when the user asks whether Codex Claw is installed, whether the loaded context is visible, or whether their AGENTS.md and SOUL.md files conflict with native Codex behavior.

## Checks

1. Ask the user to start a fresh session if they are testing session-start loading.
2. Verify whether CODEX_CLAW_CONTEXT or CODEX_CLAW_SENTINEL is visible without reading files.
3. If asked about post-compaction behavior, check that UserPromptSubmit is installed and that userPromptReinject is after_compact or every_prompt.
4. If asked to inspect compatibility, review the loaded text for conflicts with native Codex priority rules, available tools, file-editing expectations, and safety boundaries.
5. Separate findings into remove, scope, and keep.
`;

function resolveTilde(input: string, homeDir: string): string {
  if (input === "~") {
    return homeDir;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(homeDir, input.slice(2));
  }
  return input;
}

function resolvePath(input: string, homeDir: string): string {
  return path.resolve(resolveTilde(input, homeDir));
}

function resolveCodexHome(options: { codexHome?: string; env?: NodeJS.ProcessEnv }): string {
  const env = options.env ?? process.env;
  const osHome = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  return resolvePath(options.codexHome?.trim() || path.join(osHome, ".codex"), osHome);
}

function defaultWorkspaceFile(workspaceDir: string | undefined, filename: string): string {
  return path.resolve(workspaceDir || process.cwd(), filename);
}

function validateMode(mode: string | undefined): CodexClawMode {
  if (mode === undefined || mode === "full" || mode === "sentinel" || mode === "off") {
    return mode ?? "full";
  }
  throw new Error(`invalid Codex Claw mode: ${mode}`);
}

function validateUserPromptReinject(policy: string | undefined): CodexClawUserPromptReinject {
  if (
    policy === undefined ||
    policy === "after_compact" ||
    policy === "every_prompt" ||
    policy === "off"
  ) {
    return policy ?? "after_compact";
  }
  throw new Error(`invalid Codex Claw prompt reinjection policy: ${policy}`);
}

function buildMarketplaceJson(): string {
  return `${JSON.stringify(
    {
      name: "openclaw-codex-claw",
      interface: {
        displayName: "Codex Claw",
      },
      plugins: [
        {
          name: "codex-claw",
          source: {
            source: "local",
            path: "./plugins/codex-claw",
          },
          policy: {
            installation: "INSTALLED_BY_DEFAULT",
            authentication: "ON_INSTALL",
          },
          category: "Productivity",
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function buildPluginManifestJson(): string {
  return `${JSON.stringify(
    {
      name: "codex-claw",
      version: CODEX_CLAW_PLUGIN_VERSION,
      description:
        "Loads configured AGENTS.md and SOUL.md context into Codex Desktop sessions through Codex hooks.",
      author: {
        name: "OpenClaw",
        url: "https://github.com/openclaw/openclaw",
      },
      homepage: "https://github.com/openclaw/openclaw",
      repository: "https://github.com/openclaw/openclaw",
      license: "MIT",
      keywords: ["codex", "openclaw", "soul", "agents", "session-start", "hooks"],
      skills: "./skills/",
      hooks: "./hooks.json",
      interface: {
        displayName: "Codex Claw",
        shortDescription: "Load your OpenClaw AGENTS.md and SOUL.md context into Codex sessions.",
        longDescription:
          "Codex Claw is a local Codex Desktop plugin payload generated by OpenClaw. It loads user-configured AGENTS.md and SOUL.md files as lower-priority session bootstrap context.",
        developerName: "OpenClaw",
        category: "Productivity",
        capabilities: ["Interactive", "Read"],
        websiteURL: "https://github.com/openclaw/openclaw",
        privacyPolicyURL: "https://github.com/openclaw/openclaw",
        termsOfServiceURL: "https://github.com/openclaw/openclaw",
        defaultPrompt: [
          "Check whether Codex Claw context is present.",
          "Review my loaded AGENTS.md and SOUL.md for native Codex compatibility.",
        ],
        brandColor: "#2563EB",
        screenshots: [],
      },
    },
    null,
    2,
  )}\n`;
}

function buildHooksJson(): string {
  return `${JSON.stringify(
    {
      hooks: {
        SessionStart: [
          {
            matcher: "startup|resume|clear|compact",
            hooks: [
              {
                type: "command",
                shell: "bash",
                command: HOOK_SCRIPT_FINDER.replace("HOOK_EVENT", "SessionStart"),
                timeout: 30,
              },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                shell: "bash",
                command: HOOK_SCRIPT_FINDER.replace("HOOK_EVENT", "UserPromptSubmit"),
                timeout: 30,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

function buildPayloadFiles(): Array<{ relativePath: string; content: string }> {
  return [
    { relativePath: ".agents/plugins/marketplace.json", content: buildMarketplaceJson() },
    {
      relativePath: `${PAYLOAD_ROOT}/.codex-plugin/plugin.json`,
      content: buildPluginManifestJson(),
    },
    { relativePath: `${PAYLOAD_ROOT}/hooks.json`, content: buildHooksJson() },
    { relativePath: `${PAYLOAD_ROOT}/scripts/load-context.mjs`, content: LOAD_CONTEXT_SCRIPT },
    {
      relativePath: `${PAYLOAD_ROOT}/assets/AGENTS.md`,
      content:
        "# AGENTS.md\n\nThis placeholder is intentionally not the user's OpenClaw AGENTS.md. OpenClaw writes ~/.codex/codex-claw.json with explicit source paths instead.\n",
    },
    {
      relativePath: `${PAYLOAD_ROOT}/assets/SOUL.md`,
      content:
        "# SOUL.md\n\nThis placeholder is intentionally not the user's OpenClaw SOUL.md. OpenClaw writes ~/.codex/codex-claw.json with explicit source paths instead.\n",
    },
    { relativePath: `${PAYLOAD_ROOT}/skills/codex-claw/SKILL.md`, content: SKILL_CONTENT },
  ];
}

function writePayloadFiles(marketplaceDir: string): string[] {
  const wroteFiles: string[] = [];
  for (const file of buildPayloadFiles()) {
    const target = path.join(marketplaceDir, file.relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
    wroteFiles.push(target);
  }
  return wroteFiles;
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function parseConfig(filePath: string): { config?: Partial<CodexClawUserConfig>; error?: string } {
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    return { config: readJsonFile(filePath) as Partial<CodexClawUserConfig> };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function installCodexClawBridge(
  options: CodexClawInstallOptions = {},
): CodexClawInstallResult {
  const env = options.env ?? process.env;
  const osHome = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const codexHome = resolveCodexHome({ codexHome: options.codexHome, env });
  const marketplaceDir = path.join(codexHome, CODEX_CLAW_MARKETPLACE_DIRNAME);
  const configPath = path.join(codexHome, CODEX_CLAW_CONFIG_FILENAME);
  const agentsPath = resolvePath(
    options.agentsPath?.trim() || defaultWorkspaceFile(options.workspaceDir, "AGENTS.md"),
    osHome,
  );
  const soulPath = resolvePath(
    options.soulPath?.trim() || defaultWorkspaceFile(options.workspaceDir, "SOUL.md"),
    osHome,
  );
  const mode = validateMode(options.mode);
  const userPromptReinject = validateUserPromptReinject(options.userPromptReinject);
  const warnings: string[] = [];

  if (!existsSync(agentsPath)) {
    warnings.push(`AGENTS.md path does not exist yet: ${agentsPath}`);
  }
  if (!existsSync(soulPath)) {
    warnings.push(`SOUL.md path does not exist yet: ${soulPath}`);
  }

  mkdirSync(codexHome, { recursive: true });
  const wroteFiles = writePayloadFiles(marketplaceDir);
  const config: CodexClawUserConfig = {
    agentsPath,
    soulPath,
    mode,
    userPromptReinject,
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  wroteFiles.push(configPath);

  return {
    codexHome,
    marketplaceDir,
    configPath,
    agentsPath,
    soulPath,
    mode,
    userPromptReinject,
    wroteFiles,
    warnings,
  };
}

export function readCodexClawStatus(options: CodexClawStatusOptions = {}): CodexClawStatus {
  const codexHome = resolveCodexHome({ codexHome: options.codexHome, env: options.env });
  const marketplaceDir = path.join(codexHome, CODEX_CLAW_MARKETPLACE_DIRNAME);
  const configPath = path.join(codexHome, CODEX_CLAW_CONFIG_FILENAME);
  const missingPayloadFiles = PAYLOAD_FILES.filter(
    (relativePath) => !existsSync(path.join(marketplaceDir, relativePath)),
  );
  const parsed = parseConfig(configPath);
  const config = parsed.config;
  const agentsPath = typeof config?.agentsPath === "string" ? config.agentsPath : undefined;
  const soulPath = typeof config?.soulPath === "string" ? config.soulPath : undefined;

  return {
    codexHome,
    marketplaceDir,
    configPath,
    marketplaceInstalled: missingPayloadFiles.length === 0,
    configExists: existsSync(configPath),
    ...(parsed.error ? { configError: parsed.error } : {}),
    ...(agentsPath ? { agentsPath, agentsPathExists: existsSync(agentsPath) } : {}),
    ...(soulPath ? { soulPath, soulPathExists: existsSync(soulPath) } : {}),
    ...(typeof config?.mode === "string" ? { mode: config.mode } : {}),
    ...(typeof config?.userPromptReinject === "string"
      ? { userPromptReinject: config.userPromptReinject }
      : {}),
    missingPayloadFiles: [...missingPayloadFiles],
  };
}

export function formatInstallResult(result: CodexClawInstallResult): string {
  const lines = [
    "Codex Claw bridge files installed.",
    "",
    `Codex home: ${result.codexHome}`,
    `Marketplace: ${result.marketplaceDir}`,
    `Config: ${result.configPath}`,
    `AGENTS.md: ${result.agentsPath}`,
    `SOUL.md: ${result.soulPath}`,
    `Post-compaction reinjection: ${result.userPromptReinject}`,
  ];
  if (result.warnings.length > 0) {
    lines.push("", "Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  }
  lines.push(
    "",
    "Next steps:",
    `1. Run: codex plugin marketplace add ${JSON.stringify(result.marketplaceDir)}`,
    "2. Ensure ~/.codex/config.toml enables plugins, codex_hooks, plugin_hooks, and the codex-claw plugin table.",
    "3. Restart Codex Desktop, then ask a fresh session whether CODEX_CLAW_CONTEXT is present.",
  );
  return lines.join("\n");
}

export function formatStatus(status: CodexClawStatus): string {
  const lines = [
    "Codex Claw status",
    "",
    `Codex home: ${status.codexHome}`,
    `Marketplace: ${status.marketplaceInstalled ? "installed" : "missing/incomplete"} (${status.marketplaceDir})`,
    `Config: ${status.configExists ? "present" : "missing"} (${status.configPath})`,
  ];
  if (status.configError) {
    lines.push(`Config error: ${status.configError}`);
  }
  if (status.agentsPath) {
    lines.push(
      `AGENTS.md: ${status.agentsPathExists ? "present" : "missing"} (${status.agentsPath})`,
    );
  }
  if (status.soulPath) {
    lines.push(`SOUL.md: ${status.soulPathExists ? "present" : "missing"} (${status.soulPath})`);
  }
  if (status.mode) {
    lines.push(`Mode: ${status.mode}`);
  }
  if (status.userPromptReinject) {
    lines.push(`Post-compaction reinjection: ${status.userPromptReinject}`);
  }
  if (status.missingPayloadFiles.length > 0) {
    lines.push(
      "",
      "Missing payload files:",
      ...status.missingPayloadFiles.map((file) => `- ${file}`),
    );
  }
  return lines.join("\n");
}
