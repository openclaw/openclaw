import path from "node:path";
import type { buildGoogleGeminiCliBackend } from "./cli-backend.js";

export type GeminiPrepareContext = Parameters<
  NonNullable<ReturnType<typeof buildGoogleGeminiCliBackend>["prepareExecution"]>
>[0] & {
  env?: Record<string, string>;
  authCredential?: {
    type: "api_key" | "oauth" | "token";
    provider: string;
    access?: string;
    refresh?: string;
    expires?: number;
    idToken?: string;
    projectId?: string;
    key?: string;
    email?: string;
  };
  isolatedCompletionCwd?: string;
  isolatedCompletionPrompt?: string;
  isolatedCompletionSystemPrompt?: string;
  isolatedCompletionModelId?: string;
};
export type GeminiPreparedExecution = Awaited<
  ReturnType<NonNullable<ReturnType<typeof buildGoogleGeminiCliBackend>["prepareExecution"]>>
>;

export async function stageGeminiPreparedExecution(
  prepared: GeminiPreparedExecution | null | undefined,
): Promise<void> {
  await prepared?.beforeExecution?.();
}

export function buildGeminiOAuthPrepareContext(workspaceDir: string): GeminiPrepareContext {
  const agentDir = path.join(workspaceDir, "agent");
  return {
    workspaceDir,
    agentDir,
    provider: "google-gemini-cli",
    modelId: "gemini-3.1-pro-preview",
    authProfileId: "google-gemini-cli:user@example.test",
    // Private bundled-runtime bridge, not public Plugin SDK surface.
    authCredential: {
      type: "oauth",
      provider: "google-gemini-cli",
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_800_000_000_000,
      idToken: "id-token",
      projectId: "profile-project",
      email: "user@example.test",
    },
  };
}
