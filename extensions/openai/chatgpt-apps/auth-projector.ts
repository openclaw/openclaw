import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { resolveProviderAuths } from "openclaw/plugin-sdk/provider-auth";
import { resolveCodexAuthIdentity } from "../openai-codex-auth-identity.js";

export type ChatgptAppsResolvedAuth =
  | {
      status: "ok";
      accessToken: string;
      accountId: string;
      planType: string | null;
      identity: ReturnType<typeof resolveCodexAuthIdentity>;
    }
  | {
      status: "missing-auth";
      message: string;
    }
  | {
      status: "missing-account-id";
      message: string;
      accessToken: string;
      identity: ReturnType<typeof resolveCodexAuthIdentity>;
    }
  | {
      status: "error";
      message: string;
    };

export async function resolveChatgptAppsProjectedAuth(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<ChatgptAppsResolvedAuth> {
  try {
    const auths = await resolveProviderAuths({
      providers: ["openai-codex"],
      config: params.config,
      env: params.env,
    });
    const auth = auths.find((entry) => entry.provider === "openai-codex");
    if (!auth?.token) {
      return {
        status: "missing-auth",
        message: "OpenAI Codex OAuth is not configured in OpenClaw.",
      };
    }

    const identity = resolveCodexAuthIdentity({
      accessToken: auth.token,
    });

    if (!auth.accountId) {
      return {
        status: "missing-account-id",
        message:
          "OpenAI Codex OAuth is present, but the credential does not expose a ChatGPT account id. Re-login with openai-codex before enabling ChatGPT apps.",
        accessToken: auth.token,
        identity,
      };
    }

    return {
      status: "ok",
      accessToken: auth.token,
      accountId: auth.accountId,
      planType: null,
      identity,
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
