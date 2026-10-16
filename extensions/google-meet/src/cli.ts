import type { Command } from "commander";
import { generateHexPkceVerifierChallenge } from "openclaw/plugin-sdk/provider-auth";
import { generateOAuthState } from "openclaw/plugin-sdk/provider-auth-runtime";
import { registerGoogleMeetArtifactCommands } from "./cli-artifact-commands.js";
import type { GoogleMeetCliCommandContext } from "./cli-command-context.js";
import { registerGoogleMeetDoctorCommand } from "./cli-doctor.js";
import {
  registerGoogleMeetLifecycleCommands,
  registerGoogleMeetProbeCommands,
  registerGoogleMeetSessionCommands,
} from "./cli-runtime-commands.js";
import {
  promptInput,
  resolveGoogleMeetOAuthCallbackTimeoutMs,
  type OAuthLoginOptions,
  writeStdoutJson,
  writeStdoutLine,
} from "./cli-shared.js";
import {
  registerGoogleMeetApiCommands,
  registerGoogleMeetCreateCommands,
} from "./cli-space-commands.js";
import { resolveGoogleMeetGatewayOperationTimeoutMs, type GoogleMeetConfig } from "./config.js";
import {
  buildGoogleMeetAuthUrl,
  exchangeGoogleMeetAuthCode,
  waitForGoogleMeetAuthCode,
} from "./oauth.js";
import type { GoogleMeetRuntime } from "./runtime.js";

export function registerGoogleMeetCli(params: {
  program: Command;
  config: GoogleMeetConfig;
  ensureRuntime: () => Promise<GoogleMeetRuntime>;
}): void {
  const operationTimeoutMs = resolveGoogleMeetGatewayOperationTimeoutMs(params.config);
  const root = params.program
    .command("googlemeet")
    .description("Google Meet participant utilities")
    .addHelpText("after", () => `\nDocs: https://docs.openclaw.ai/plugins/google-meet\n`);

  const auth = root.command("auth").description("Google Meet OAuth helpers");

  auth
    .command("login")
    .description("Run a PKCE OAuth flow and print refresh-token JSON to store in plugin config")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--manual", "Use copy/paste callback flow instead of localhost callback")
    .option("--json", "Print the token payload as JSON", false)
    .option("--timeout-sec <n>", "Local callback timeout in seconds", "300")
    .action(async (options: OAuthLoginOptions) => {
      const clientId = options.clientId?.trim() || params.config.oauth.clientId;
      const clientSecret = options.clientSecret?.trim() || params.config.oauth.clientSecret;
      if (!clientId) {
        throw new Error(
          "Missing Google Meet OAuth client id. Configure oauth.clientId or pass --client-id.",
        );
      }
      const { verifier, challenge } = generateHexPkceVerifierChallenge();
      const state = generateOAuthState();
      const authUrl = buildGoogleMeetAuthUrl({
        clientId,
        challenge,
        state,
      });
      const code = await waitForGoogleMeetAuthCode({
        state,
        manual: Boolean(options.manual),
        timeoutMs: resolveGoogleMeetOAuthCallbackTimeoutMs(options.timeoutSec),
        authUrl,
        promptInput,
        writeLine: (message) => writeStdoutLine("%s", message),
      });
      const tokens = await exchangeGoogleMeetAuthCode({
        clientId,
        clientSecret,
        code,
        verifier,
      });
      if (!tokens.refreshToken) {
        throw new Error(
          "Google OAuth did not return a refresh token. Re-run the flow with consent and offline access.",
        );
      }
      const payload = {
        oauth: {
          clientId,
          ...(clientSecret ? { clientSecret } : {}),
          refreshToken: tokens.refreshToken,
          accessToken: tokens.accessToken,
          expiresAt: tokens.expiresAt,
        },
        scope: tokens.scope,
        tokenType: tokens.tokenType,
      };
      if (!options.json) {
        writeStdoutLine("Paste this into plugins.entries.google-meet.config:");
      }
      writeStdoutJson(payload);
    });
  const context: GoogleMeetCliCommandContext = {
    root,
    config: params.config,
    ensureRuntime: params.ensureRuntime,
    operationTimeoutMs,
  };

  registerGoogleMeetCreateCommands(context);
  registerGoogleMeetProbeCommands(context);
  registerGoogleMeetApiCommands(context);
  registerGoogleMeetArtifactCommands(context);
  registerGoogleMeetSessionCommands(context);
  registerGoogleMeetDoctorCommand(context);
  registerGoogleMeetLifecycleCommands(context);
}
