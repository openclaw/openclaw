import { getRootOptionAwareCommandPath } from "../../cli-root-options.mjs";
import {
  readCodexCliActiveApiKey,
  type CodexCliApiKeyCredential,
} from "../../src/agents/cli-credentials.ts";

export const OPENCLAW_QA_CODEX_API_KEY_HANDOFF = "OPENCLAW_QA_CODEX_API_KEY_HANDOFF";

export type ReadQaCodexApiKey = (options?: {
  codexHome?: string;
  allowKeychainPrompt?: boolean;
}) => CodexCliApiKeyCredential | null;

const PORTABLE_QA_OPENAI_AUTH_ENV_KEYS = [
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENCLAW_LIVE_CODEX_API_KEY",
  "OPENCLAW_LIVE_OPENAI_KEY",
] as const;

function selectsLiveFrontierQaSuite(args: readonly string[]): boolean {
  const [rootCommand, nestedCommand] = getRootOptionAwareCommandPath(
    ["node", "openclaw", ...args],
    2,
  );
  if (rootCommand !== "qa" || nestedCommand !== "suite") {
    return false;
  }
  return args.some(
    (arg, index) =>
      arg === "--provider-mode=live-frontier" ||
      (arg === "--provider-mode" && args[index + 1] === "live-frontier"),
  );
}

export function resolveQaCodexApiKeyEnvPatch(params: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  readCodexApiKey?: ReadQaCodexApiKey;
}): NodeJS.ProcessEnv | undefined {
  if (
    !selectsLiveFrontierQaSuite(params.args) ||
    PORTABLE_QA_OPENAI_AUTH_ENV_KEYS.some((envKey) => params.env[envKey]?.trim())
  ) {
    return undefined;
  }
  const codexHome = params.env.CODEX_HOME?.trim();
  const credential = (params.readCodexApiKey ?? readCodexCliActiveApiKey)({
    ...(codexHome ? { codexHome } : {}),
    allowKeychainPrompt: false,
  });
  return credential ? { [OPENCLAW_QA_CODEX_API_KEY_HANDOFF]: credential.key } : undefined;
}
