import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { decodeOpenAICodexJwtPayload } from "openclaw/plugin-sdk/provider-oauth-runtime";
import {
  asNonArrayRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveFastModeSupport, resolveServiceTiers } from "./provider-policy-api.js";
import { isSIWCAuthFlow } from "./token-sharing.js";

const noopAuth = async () => ({ profiles: [] });
const OPENAI_ACCOUNT_WIZARD_GROUP = {
  groupId: "openai",
  groupLabel: "OpenAI",
  groupHint: "Codex login, Sign in with ChatGPT (Beta), or API key",
} as const;
const CODEX_CHATGPT_IMPORT = {
  migrationProviderId: "codex",
  itemId: "auth:openai",
  credentialKind: "oauth",
} as const;
const CODEX_API_KEY_IMPORT = {
  migrationProviderId: "codex",
  itemId: "auth:openai:api-key",
  credentialKind: "api_key",
} as const;

const matchesTokenSharingAccount: NonNullable<
  ProviderPlugin["auth"][number]["matchesPersonalAccount"]
> = (credential, existing) => {
  if (
    credential.type !== "oauth" ||
    existing.type !== "oauth" ||
    credential.provider !== "openai" ||
    existing.provider !== "openai" ||
    !isSIWCAuthFlow(credential.authFlow) ||
    !isSIWCAuthFlow(existing.authFlow) ||
    !credential.idToken ||
    !existing.idToken ||
    !credential.clientId ||
    credential.clientId !== existing.clientId
  ) {
    return false;
  }
  // Issuance verified these ID tokens; decoding here only compares persisted subjects.
  const current = decodeOpenAICodexJwtPayload(credential.idToken);
  const previous = decodeOpenAICodexJwtPayload(existing.idToken);
  return Boolean(current?.sub && current.sub === previous?.sub && current.iss === previous?.iss);
};

function accountSubject(access: string): { accountId: string; userId: string } | undefined {
  const claims = asNonArrayRecord(
    decodeOpenAICodexJwtPayload(access)?.["https://api.openai.com/auth"],
  );
  const accountId = normalizeOptionalString(claims.chatgpt_account_id);
  const userId =
    normalizeOptionalString(claims.chatgpt_user_id) ?? normalizeOptionalString(claims.user_id);
  return accountId && userId ? { accountId, userId } : undefined;
}

const matchesPersonalAccount: NonNullable<
  ProviderPlugin["auth"][number]["matchesPersonalAccount"]
> = (credential, existing) => {
  if (
    credential.type !== "oauth" ||
    existing.type !== "oauth" ||
    credential.provider !== "openai" ||
    existing.provider !== credential.provider
  ) {
    return false;
  }
  // A ChatGPT account is a workspace, not a person. Reconnect also requires
  // the exact user; missing claims must not replace any owned credential.
  const subject = accountSubject(credential.access);
  const previous = accountSubject(existing.access);
  return Boolean(
    subject && previous?.accountId === subject.accountId && previous.userId === subject.userId,
  );
};

export function createOpenAIProvider(): ProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    hookAliases: ["azure-openai", "azure-openai-responses"],
    docsPath: "/providers/models",
    envVars: ["OPENAI_API_KEY"],
    resolveFastModeSupport,
    resolveServiceTiers,
    auth: (
      [
        {
          id: "oauth",
          kind: "oauth",
          label: "Codex login (browser)",
          hint: "Sign in to Codex locally with your ChatGPT account",
          matchesPersonalAccount,
          credentialImport: CODEX_CHATGPT_IMPORT,
          wizard: {
            choiceId: "openai",
            assistantPriority: -10,
          },
        },
        {
          id: "device-code",
          kind: "device_code",
          label: "Codex login (device code)",
          hint: "Use a browser code when OpenClaw runs on a remote VM",
          matchesPersonalAccount,
          credentialImport: CODEX_CHATGPT_IMPORT,
          wizard: {
            choiceId: "openai-device-code",
            assistantPriority: -40,
            onboardingFeatured: true,
          },
        },
        {
          id: "siwc",
          kind: "oauth",
          label: "Sign in with ChatGPT (Beta)",
          hint: "Authorize OpenClaw for eligible Responses models using your Codex allowance",
          matchesPersonalAccount: matchesTokenSharingAccount,
          wizard: {
            choiceId: "openai-token-sharing",
            assistantPriority: 0,
          },
        },
        {
          id: "api-key",
          kind: "api_key",
          label: "OpenAI API Key",
          hint: "Use your OpenAI API key directly",
          credentialImport: CODEX_API_KEY_IMPORT,
          wizard: {
            choiceId: "openai-api-key",
            assistantPriority: 5,
            onboardingFeatured: true,
          },
        },
      ] satisfies Omit<ProviderPlugin["auth"][number], "run">[]
    ).map((method) =>
      Object.assign({}, method, {
        run: noopAuth,
        wizard: {
          ...method.wizard,
          choiceLabel: method.label,
          choiceHint: method.hint,
          ...OPENAI_ACCOUNT_WIZARD_GROUP,
        },
      }),
    ),
  };
}
