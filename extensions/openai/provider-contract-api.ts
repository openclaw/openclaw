// Openai API module exposes the plugin public contract.
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { decodeOpenAICodexJwtPayload } from "openclaw/plugin-sdk/provider-oauth-runtime";
import {
  asNonArrayRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { isSIWCAuthFlow } from "./token-sharing.js";

const noopAuth = async () => ({ profiles: [] });
const OPENAI_API_KEY_LABEL = "OpenAI API Key";
const OPENAI_CHATGPT_LOGIN_LABEL = "Codex login (browser)";
const OPENAI_CHATGPT_LOGIN_HINT = "Sign in to Codex with your ChatGPT account";
const OPENAI_CHATGPT_DEVICE_PAIRING_LABEL = "Codex login (device code)";
const OPENAI_CHATGPT_DEVICE_PAIRING_HINT = "Approve Codex access using a code in your browser";
const OPENAI_ACCOUNT_WIZARD_GROUP = {
  groupId: "openai",
  groupLabel: "OpenAI",
  groupHint: "Codex login, Sign in with ChatGPT, or API key",
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
    auth: [
      {
        id: "oauth",
        kind: "oauth",
        label: OPENAI_CHATGPT_LOGIN_LABEL,
        hint: OPENAI_CHATGPT_LOGIN_HINT,
        run: noopAuth,
        matchesPersonalAccount,
        credentialImport: CODEX_CHATGPT_IMPORT,
        wizard: {
          choiceId: "openai",
          choiceLabel: OPENAI_CHATGPT_LOGIN_LABEL,
          choiceHint: OPENAI_CHATGPT_LOGIN_HINT,
          assistantPriority: -10,
          ...OPENAI_ACCOUNT_WIZARD_GROUP,
        },
      },
      {
        id: "device-code",
        kind: "device_code",
        label: OPENAI_CHATGPT_DEVICE_PAIRING_LABEL,
        hint: OPENAI_CHATGPT_DEVICE_PAIRING_HINT,
        run: noopAuth,
        matchesPersonalAccount,
        credentialImport: CODEX_CHATGPT_IMPORT,
        wizard: {
          choiceId: "openai-device-code",
          choiceLabel: OPENAI_CHATGPT_DEVICE_PAIRING_LABEL,
          choiceHint: OPENAI_CHATGPT_DEVICE_PAIRING_HINT,
          assistantPriority: -40,
          onboardingFeatured: true,
          ...OPENAI_ACCOUNT_WIZARD_GROUP,
        },
      },
      {
        id: "siwc",
        kind: "oauth",
        label: "Sign in with ChatGPT",
        hint: "Use your ChatGPT allowance through the Responses API",
        run: noopAuth,
        matchesPersonalAccount: matchesTokenSharingAccount,
        wizard: {
          choiceId: "openai-token-sharing",
          choiceLabel: "Sign in with ChatGPT",
          choiceHint: "Use your ChatGPT allowance through the Responses API",
          assistantPriority: 0,
          ...OPENAI_ACCOUNT_WIZARD_GROUP,
        },
      },
      {
        id: "api-key",
        kind: "api_key",
        label: OPENAI_API_KEY_LABEL,
        hint: "Use your OpenAI API key directly",
        run: noopAuth,
        credentialImport: CODEX_API_KEY_IMPORT,
        wizard: {
          choiceId: "openai-api-key",
          choiceLabel: OPENAI_API_KEY_LABEL,
          choiceHint: "Use your OpenAI API key directly",
          assistantPriority: 5,
          onboardingFeatured: true,
          ...OPENAI_ACCOUNT_WIZARD_GROUP,
        },
      },
    ],
  };
}
