import { afterEach, expect, it, vi } from "vitest";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);

afterEach(() => {
  supervisorSpawnMock.mockReset();
  vi.unstubAllEnvs();
});

it.each(["ambient", "configured", "prepared", "mixed-case"] as const)(
  "keeps native-login automations free of %s host credentials at spawn",
  async (source) => {
    vi.stubEnv("OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV", '["ANTHROPIC_API_KEY"]');
    vi.stubEnv("ANTHROPIC_API_KEY", source === "ambient" ? "synthetic-host-key" : "");
    vi.stubEnv("OPENAI_API_KEY", source === "ambient" ? "synthetic-other-provider-key" : "");
    vi.stubEnv("Claude_Code_Oauth_Token", "synthetic-host-token");
    vi.stubEnv("Claude_Code_Provider_Managed_By_Host", "synthetic-host-marker");
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        ...createSuccessfulProcessExit(),
        stdout: `${JSON.stringify({ type: "result", result: "native login" })}\n`,
      }),
    );
    const context = buildPreparedCliRunContext({
      model: "claude-sonnet-4-6",
      config: {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://example.invalid",
              apiKey: "synthetic-provider-config-key",
              models: [],
            },
          },
        },
      },
      preparedEnv: {
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000",
        ...(source === "prepared"
          ? {
              OPENAI_API_KEY: "synthetic-prepared-key",
              CLAUDE_CODE_OAUTH_TOKEN: "synthetic-prepared-token",
            }
          : {}),
        ...(source === "mixed-case"
          ? {
              Openai_Api_Key: "synthetic-prepared-key",
              Claude_Code_Oauth_Token: "synthetic-prepared-token",
            }
          : {}),
      },
      backend: {
        env:
          source === "configured"
            ? {
                ANTHROPIC_API_KEY: "synthetic-backend-key",
                OPENAI_API_KEY: "synthetic-other-provider-key",
              }
            : source === "mixed-case"
              ? { Anthropic_Api_Key: "synthetic-backend-key" }
              : {},
        clearEnv: [
          "ANTHROPIC_API_KEY",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
        ],
      },
    });
    context.params.trigger = "cron";
    context.params.nativeAuthOnly = true;

    await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "native login" });

    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
    const input = supervisorSpawnMock.mock.calls[0]?.[0];
    expect(input?.env?.ANTHROPIC_API_KEY === undefined).toBe(true);
    expect(input?.env?.OPENAI_API_KEY === undefined).toBe(true);
    expect(input?.env?.Anthropic_Api_Key === undefined).toBe(true);
    expect(input?.env?.Openai_Api_Key === undefined).toBe(true);
    expect(input?.env?.Claude_Code_Oauth_Token === undefined).toBe(true);
    expect(input?.env?.CLAUDE_CODE_OAUTH_TOKEN === undefined).toBe(true);
    expect(input?.env?.Claude_Code_Provider_Managed_By_Host === undefined).toBe(true);
    expect(input?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("100000");
  },
);
