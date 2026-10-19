import type { Command } from "commander";
import type { MeetingSetupCheck } from "openclaw/plugin-sdk/meeting-runtime";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { generateHexPkceVerifierChallenge } from "openclaw/plugin-sdk/provider-auth";
import { generateOAuthState } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  addGoogleMeetArtifactOptions,
  addGoogleMeetOAuthOptions,
  callGoogleMeetRuntime,
  resolveCliMeetingInput as resolveMeetingInput,
  resolveCliParams,
  type GoogleMeetCliCommandContext,
} from "./cli-command-context.js";
import {
  exportGoogleMeetBundle,
  renderArtifacts,
  renderAttendanceCsv,
  renderAttendance,
} from "./cli-export.js";
import {
  parseGoogleMeetBrowserTransport,
  parseGoogleMeetMode,
  parseGoogleMeetTransport,
  parseOptionalNumber,
  parsePositiveIntegerOption,
  parsePositiveNumber,
  promptInput,
  resolveCliJoinRequest,
  resolveGoogleMeetOAuthCallbackTimeoutMs,
  type DoctorOptions,
  type JoinOptions,
  type MeetArtifactOptions,
  type OAuthLoginOptions,
  type RecoverTabOptions,
  type SetupOptions,
  writeCliOutput,
  writeDoctorStatus,
  writeLeaveResult,
  writeRecoverCurrentTabResult,
  writeSetupStatus,
  writeStdoutJson,
  writeStdoutLine,
} from "./cli-shared.js";
import {
  registerGoogleMeetApiCommands,
  registerGoogleMeetCreateCommands,
} from "./cli-space-commands.js";
import { resolveGoogleMeetGatewayOperationTimeoutMs, type GoogleMeetConfig } from "./config.js";
import { createGoogleMeetSpace, fetchGoogleMeetSpace } from "./meet-api.js";
import {
  buildGoogleMeetAuthUrl,
  exchangeGoogleMeetAuthCode,
  resolveGoogleMeetAccessToken,
  waitForGoogleMeetAuthCode,
} from "./oauth.js";
import {
  buildGoogleMeetExportRequest,
  fetchResolvedGoogleMeetArtifacts,
  fetchResolvedGoogleMeetAttendance,
  resolveArtifactQueryFromParams,
} from "./plugin-helpers.js";
import type { GoogleMeetRuntime } from "./runtime.js";

type OAuthDoctorReport = {
  ok: boolean;
  configured: boolean;
  tokenSource?: "cached-access-token" | "refresh-token";
  expiresAt?: number;
  scope?: string;
  meetingUri?: string;
  createdSpace?: string;
  checks: MeetingSetupCheck[];
};

function sanitizeOAuthErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(access_token["'=:\s]+)[^"',\s&]+/gi, "$1[redacted]")
    .replace(/(refresh_token["'=:\s]+)[^"',\s&]+/gi, "$1[redacted]")
    .replace(/(client_secret["'=:\s]+)[^"',\s&]+/gi, "$1[redacted]");
}

async function buildOAuthDoctorReport(
  config: GoogleMeetConfig,
  options: DoctorOptions,
): Promise<OAuthDoctorReport> {
  const clientId = options.clientId?.trim() || config.oauth.clientId;
  const clientSecret = options.clientSecret?.trim() || config.oauth.clientSecret;
  const refreshToken = options.refreshToken?.trim() || config.oauth.refreshToken;
  const accessToken = options.accessToken?.trim() || config.oauth.accessToken;
  const expiresAt = parseOptionalNumber(options.expiresAt) ?? config.oauth.expiresAt;
  const checks: MeetingSetupCheck[] = [];

  const hasRefreshConfig = Boolean(clientId && refreshToken);
  const hasAccessConfig = Boolean(accessToken);
  if (!hasRefreshConfig && !hasAccessConfig) {
    checks.push({
      id: "oauth-config",
      ok: false,
      message:
        "Missing Google Meet OAuth credentials. Configure oauth.clientId and oauth.refreshToken, or pass --client-id and --refresh-token.",
    });
    return { ok: false, configured: false, checks };
  }

  checks.push({
    id: "oauth-config",
    ok: true,
    message: hasRefreshConfig
      ? "Google Meet OAuth refresh credentials are configured"
      : "Google Meet cached access token is configured",
  });

  let token: Awaited<ReturnType<typeof resolveGoogleMeetAccessToken>>;
  try {
    token = await resolveGoogleMeetAccessToken({
      clientId,
      clientSecret,
      refreshToken,
      accessToken,
      expiresAt,
    });
    checks.push({
      id: "oauth-token",
      ok: true,
      message: token.refreshed
        ? "Refresh token minted an access token"
        : "Cached access token is still valid",
    });
  } catch (error) {
    checks.push({
      id: "oauth-token",
      ok: false,
      message: sanitizeOAuthErrorMessage(error),
    });
    return { ok: false, configured: true, checks };
  }

  const report: OAuthDoctorReport = {
    ok: true,
    configured: true,
    tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
    expiresAt: token.expiresAt,
    checks,
  };

  const meeting = options.meeting?.trim();
  if (meeting) {
    try {
      const space = await fetchGoogleMeetSpace({ accessToken: token.accessToken, meeting });
      checks.push({
        id: "meet-spaces-get",
        ok: true,
        message: `Resolved ${space.name}`,
      });
      report.meetingUri = space.meetingUri;
    } catch (error) {
      checks.push({
        id: "meet-spaces-get",
        ok: false,
        message: sanitizeOAuthErrorMessage(error),
      });
    }
  }

  if (options.createSpace) {
    try {
      const created = await createGoogleMeetSpace({ accessToken: token.accessToken });
      checks.push({
        id: "meet-spaces-create",
        ok: true,
        message: `Created ${created.space.name}`,
      });
      report.createdSpace = created.space.name;
      report.meetingUri = created.meetingUri;
    } catch (error) {
      checks.push({
        id: "meet-spaces-create",
        ok: false,
        message: sanitizeOAuthErrorMessage(error),
      });
    }
  }

  report.ok = checks.every((check) => check.ok);
  return report;
}

function writeOAuthDoctorReport(report: OAuthDoctorReport): void {
  writeStdoutLine("Google Meet OAuth: %s", report.ok ? "OK" : "needs attention");
  writeStdoutLine("configured: %s", report.configured ? "yes" : "no");
  if (report.tokenSource) {
    writeStdoutLine("token source: %s", report.tokenSource);
  }
  if (report.meetingUri) {
    writeStdoutLine("meeting uri: %s", report.meetingUri);
  }
  for (const check of report.checks) {
    writeStdoutLine("[%s] %s: %s", check.ok ? "ok" : "fail", check.id, check.message);
  }
}

function resolveTokenSource(refreshed: boolean) {
  return refreshed ? "refresh-token" : "cached-access-token";
}

async function writeArtifactOutput<T>(
  options: MeetArtifactOptions,
  result: T,
  refreshed: boolean,
  render: (result: T, format: "summary" | "markdown") => string,
  csv?: (result: T) => string,
): Promise<void> {
  const tokenSource = resolveTokenSource(refreshed);
  let text: string;
  if (options.json) {
    text = JSON.stringify({ ...result, tokenSource }, null, 2);
  } else if (options.format === "markdown") {
    text = render(result, "markdown");
  } else if (options.format === "csv" && csv) {
    text = csv(result);
  } else if (!options.format || options.format === "summary") {
    text = `${render(result, "summary")}token source: ${tokenSource}\n`;
  } else {
    throw new Error(
      csv
        ? "Unsupported format. Expected summary, markdown, or csv."
        : "Unsupported format. Expected summary or markdown.",
    );
  }
  await writeCliOutput(options, text);
}

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

  root
    .command("join")
    .argument("[url]", "Explicit https://meet.google.com/... URL")
    .option("--transport <transport>", "Transport: chrome, chrome-node, or twilio")
    .option("--mode <mode>", "Mode: agent, bidi, or transcribe")
    .option("--message <text>", "Realtime speech to trigger after join")
    .option("--dial-in-number <phone>", "Meet dial-in number for Twilio transport")
    .option("--pin <pin>", "Meet phone PIN; # is appended if omitted")
    .option("--dtmf-sequence <sequence>", "Explicit Twilio DTMF sequence")
    .action(async (url: string | undefined, options: JoinOptions) => {
      const payload = resolveCliJoinRequest(resolveMeetingInput(context.config, url), options);
      const result = await callGoogleMeetRuntime(
        context,
        "googlemeet.join",
        payload,
        (rt) => rt.join(payload),
        operationTimeoutMs,
      );
      writeStdoutJson(result.session ?? result);
    });

  root
    .command("test-speech")
    .argument("[url]", "Explicit https://meet.google.com/... URL")
    .option("--transport <transport>", "Transport: chrome, chrome-node, or twilio")
    .option("--mode <mode>", "Mode: agent, bidi, or transcribe")
    .option(
      "--message <text>",
      "Realtime speech to trigger",
      "Say exactly: Google Meet speech test complete.",
    )
    .action(async (url: string | undefined, options: JoinOptions) => {
      const payload = {
        url: resolveMeetingInput(context.config, url),
        transport: parseGoogleMeetTransport(options.transport),
        mode: parseGoogleMeetMode(options.mode),
        message: options.message,
      };
      writeStdoutJson(
        await callGoogleMeetRuntime(
          context,
          "googlemeet.testSpeech",
          payload,
          (rt) => rt.testSpeech(payload),
          operationTimeoutMs,
        ),
      );
    });

  root
    .command("test-listen")
    .argument("[url]", "Explicit https://meet.google.com/... URL")
    .option("--transport <transport>", "Transport: chrome or chrome-node")
    .option("--timeout-ms <ms>", "How long to wait for fresh captions/transcript movement")
    .action(async (url: string | undefined, options: JoinOptions) => {
      const payload = {
        url: resolveMeetingInput(context.config, url),
        transport: parseGoogleMeetBrowserTransport(options.transport),
        timeoutMs: parsePositiveNumber(options.timeoutMs, "timeout-ms"),
      };
      writeStdoutJson(
        await callGoogleMeetRuntime(
          context,
          "googlemeet.testListen",
          payload,
          (rt) => rt.testListen(payload),
          operationTimeoutMs,
        ),
      );
    });

  registerGoogleMeetApiCommands(context);

  async function resolveCliArtifactQuery(options: MeetArtifactOptions) {
    const meeting = options.meeting?.trim() || context.config.defaults.meeting;
    const conferenceRecord = options.conferenceRecord?.trim();
    if (!meeting && !conferenceRecord && !(options.today || options.event?.trim())) {
      throw new Error(
        "Meeting input or conference record is required. Pass --meeting, --today, --event, --conference-record, or configure defaults.meeting.",
      );
    }
    const { lateAfterMinutes: late, earlyBeforeMinutes: early, ...queryOptions } = options;
    const raw = {
      ...resolveCliParams(queryOptions),
      meeting,
      conferenceRecord,
      pageSize: parsePositiveIntegerOption(options.pageSize, "page-size"),
      includeTranscriptEntries: options.transcriptEntries,
      includeAllConferenceRecords: options.allConferenceRecords,
      includeDocumentBodies: options.includeDocBodies,
      mergeDuplicateParticipants: options.mergeDuplicates,
    };
    const lateAfterMinutes = parseOptionalNumber(late);
    const earlyBeforeMinutes = parseOptionalNumber(early);
    return {
      ...(await resolveArtifactQueryFromParams(context.config, raw)),
      lateAfterMinutes,
      earlyBeforeMinutes,
    };
  }

  addGoogleMeetArtifactOptions(
    root
      .command("artifacts")
      .description("List Meet conference records and available participant/artifact metadata"),
  )
    .option("--no-transcript-entries", "Skip structured transcript entry lookup")
    .option("--include-doc-bodies", "Export linked transcript and smart-note Google Docs text")
    .option("--format <format>", "Output format: summary or markdown", "summary")
    .option("--output <path>", "Write output to a file instead of stdout")
    .option("--json", "Print JSON output", false)
    .action(async (options: MeetArtifactOptions) => {
      const resolved = await resolveCliArtifactQuery(options);
      const result = await fetchResolvedGoogleMeetArtifacts(resolved);
      await writeArtifactOutput(options, result, resolved.token.refreshed, renderArtifacts);
    });

  addGoogleMeetArtifactOptions(
    root.command("attendance").description("List Meet participants and participant sessions"),
  )
    .option("--no-merge-duplicates", "Keep duplicate participant resources as separate rows")
    .option("--late-after-minutes <n>", "Mark participants late after this many minutes", "5")
    .option("--early-before-minutes <n>", "Mark early leavers before this many minutes", "5")
    .option("--format <format>", "Output format: summary, markdown, or csv", "summary")
    .option("--output <path>", "Write output to a file instead of stdout")
    .option("--json", "Print JSON output", false)
    .action(async (options: MeetArtifactOptions) => {
      const resolved = await resolveCliArtifactQuery(options);
      const result = await fetchResolvedGoogleMeetAttendance(resolved);
      await writeArtifactOutput(
        options,
        result,
        resolved.token.refreshed,
        renderAttendance,
        renderAttendanceCsv,
      );
    });

  addGoogleMeetArtifactOptions(
    root
      .command("export")
      .description("Write Meet artifacts, attendance, transcript, and raw JSON into a folder"),
  )
    .option("--no-transcript-entries", "Skip structured transcript entry lookup")
    .option("--include-doc-bodies", "Export linked transcript and smart-note Google Docs text")
    .option("--no-merge-duplicates", "Keep duplicate participant resources as separate rows")
    .option("--late-after-minutes <n>", "Mark participants late after this many minutes", "5")
    .option("--early-before-minutes <n>", "Mark early leavers before this many minutes", "5")
    .option("--output <dir>", "Output directory")
    .option("--zip", "Also write a portable .zip archive")
    .option("--dry-run", "Fetch export data and print the manifest without writing files", false)
    .option("--json", "Print JSON output", false)
    .action(async (options: MeetArtifactOptions) => {
      const resolved = await resolveCliArtifactQuery(options);
      const artifacts = await fetchResolvedGoogleMeetArtifacts(resolved);
      const attendance = await fetchResolvedGoogleMeetAttendance(resolved);
      const payload = await exportGoogleMeetBundle({
        outputDir: options.output,
        artifacts,
        attendance,
        zip: Boolean(options.zip),
        dryRun: options.dryRun,
        request: buildGoogleMeetExportRequest(resolved, options.calendar),
        tokenSource: resolveTokenSource(resolved.token.refreshed),
        calendarEvent: resolved.calendarEvent,
      });
      if (options.json || "dryRun" in payload) {
        writeStdoutJson(payload);
        return;
      }
      writeStdoutLine("export: %s", payload.outputDir);
      for (const file of payload.files) {
        writeStdoutLine("- %s", file);
      }
      if (payload.zipFile) {
        writeStdoutLine("zip: %s", payload.zipFile);
      }
    });

  root
    .command("status")
    .argument("[session-id]", "Meet session ID")
    .option("--json", "Print JSON output", false)
    .action(async (sessionId?: string) => {
      writeStdoutJson(
        await callGoogleMeetRuntime(context, "googlemeet.status", { sessionId }, (rt) =>
          rt.status(sessionId),
        ),
      );
    });

  root
    .command("transcript")
    .description("Print the bounded caption transcript for a Meet session")
    .argument("<session-id>", "Meet session ID")
    .option("--since <index>", "Resume from the previous response's nextIndex")
    .option("--json", "Print JSON output", false)
    .action(async (sessionId: string, options: { since?: string; json?: boolean }) => {
      const sinceIndex = parseStrictNonNegativeInteger(options.since);
      if (options.since !== undefined && sinceIndex === undefined) {
        throw new Error("--since must be a non-negative safe integer");
      }
      const result = await callGoogleMeetRuntime(
        context,
        "googlemeet.transcript",
        { sessionId, ...(sinceIndex === undefined ? {} : { sinceIndex }) },
        (rt) => rt.transcript(sessionId, sinceIndex === undefined ? {} : { sinceIndex }),
      );
      if (!result.found) {
        throw new Error("session not found");
      }
      if (options.json) {
        writeStdoutJson(result);
        return;
      }
      if (result.evicted) {
        writeStdoutLine("# transcript evicted from runtime memory");
      } else if (result.droppedLines) {
        writeStdoutLine("# %d earlier lines dropped by the transcript cap", result.droppedLines);
      }
      for (const line of result.lines ?? []) {
        writeStdoutLine(
          "%s%s%s",
          line.at ? `[${line.at}] ` : "",
          line.speaker ? `${line.speaker}: ` : "",
          line.text,
        );
      }
      writeStdoutLine("# nextIndex: %d", result.nextIndex ?? 0);
    });

  addGoogleMeetOAuthOptions(
    root
      .command("doctor")
      .description("Show human-readable Meet session/browser/realtime health")
      .argument("[session-id]", "Meet session ID")
      .option("--oauth", "Verify Google Meet OAuth token refresh without printing secrets", false)
      .option("--meeting <value>", "Also verify spaces.get for a Meet URL, code, or spaces/{id}")
      .option(
        "--create-space",
        "Also verify spaces.create by creating a throwaway Meet space",
        false,
      ),
  )
    .option("--json", "Print JSON output", false)
    .action(async (sessionId: string | undefined, options: DoctorOptions) => {
      if (options.oauth) {
        const report = await buildOAuthDoctorReport(context.config, options);
        if (options.json) {
          writeStdoutJson(report);
          return;
        }
        writeOAuthDoctorReport(report);
        return;
      }
      const status = await callGoogleMeetRuntime(
        context,
        "googlemeet.status",
        { sessionId },
        (rt) => rt.status(sessionId),
      );
      if (options.json) {
        writeStdoutJson(status);
        return;
      }
      writeDoctorStatus(status);
    });

  root
    .command("recover-tab")
    .description("Focus and inspect an existing Google Meet tab")
    .argument("[url]", "Optional Meet URL to match")
    .option("--transport <transport>", "Transport to inspect: chrome or chrome-node")
    .option("--json", "Print JSON output", false)
    .action(async (url: string | undefined, options: RecoverTabOptions) => {
      const rt = await context.ensureRuntime();
      const result = await rt.recoverCurrentTab({
        url,
        transport: parseGoogleMeetBrowserTransport(options.transport),
      });
      if (options.json) {
        writeStdoutJson(result);
        return;
      }
      writeRecoverCurrentTabResult(result);
    });

  root
    .command("setup")
    .description("Show Google Meet transport setup status")
    .option("--transport <transport>", "Transport to check: chrome, chrome-node, or twilio")
    .option("--mode <mode>", "Mode to check: agent, bidi, or transcribe")
    .option("--json", "Print JSON output", false)
    .action(async (options: SetupOptions) => {
      const rt = await context.ensureRuntime();
      const status = await rt.setupStatus({
        transport: parseGoogleMeetTransport(options.transport),
        mode: parseGoogleMeetMode(options.mode),
      });
      if (options.json) {
        writeStdoutJson(status);
      } else {
        writeSetupStatus(status);
      }
      if (!status.ok) {
        process.exitCode = 1;
      }
    });

  root
    .command("leave")
    .argument("<session-id>", "Meet session ID")
    .action(async (sessionId: string) => {
      const result = await callGoogleMeetRuntime(context, "googlemeet.leave", { sessionId }, (rt) =>
        rt.leave(sessionId),
      );
      if (!result.found) {
        throw new Error("session not found");
      }
      writeLeaveResult(sessionId, result);
    });

  root
    .command("speak")
    .argument("<session-id>", "Meet session ID")
    .argument("[message]", "Realtime instructions to speak now")
    .action(async (sessionId: string, message?: string) => {
      const result = await callGoogleMeetRuntime(
        context,
        "googlemeet.speak",
        { sessionId, message },
        (rt) => rt.speak(sessionId, message),
      );
      if (!result.found) {
        throw new Error("session not found");
      }
      if (!result.spoken) {
        throw new Error(
          result.session?.chrome?.health?.speechBlockedMessage ??
            "session has no active realtime audio bridge",
        );
      }
      writeStdoutLine("speaking on %s", sessionId);
    });
}
