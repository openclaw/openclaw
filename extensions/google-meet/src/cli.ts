import { createInterface } from "node:readline/promises";
import { format } from "node:util";
import type { Command } from "commander";
import type { GoogleMeetConfig, GoogleMeetMode, GoogleMeetTransport } from "./config.js";
import {
  buildGoogleMeetPreflightReport,
  createGoogleMeetSpace,
  fetchGoogleMeetArtifacts,
  fetchGoogleMeetAttendance,
  fetchGoogleMeetSpace,
  type GoogleMeetArtifactsResult,
  type GoogleMeetAttendanceResult,
} from "./meet.js";
import {
  buildGoogleMeetAuthUrl,
  createGoogleMeetOAuthState,
  createGoogleMeetPkce,
  exchangeGoogleMeetAuthCode,
  resolveGoogleMeetAccessToken,
  waitForGoogleMeetAuthCode,
} from "./oauth.js";
import type { GoogleMeetRuntime } from "./runtime.js";

type JoinOptions = {
  transport?: GoogleMeetTransport;
  mode?: GoogleMeetMode;
  message?: string;
  dialInNumber?: string;
  pin?: string;
  dtmfSequence?: string;
};

type OAuthLoginOptions = {
  clientId?: string;
  clientSecret?: string;
  manual?: boolean;
  json?: boolean;
  timeoutSec?: string;
};

type ResolveSpaceOptions = {
  meeting?: string;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  expiresAt?: string;
  json?: boolean;
};

type MeetArtifactOptions = ResolveSpaceOptions & {
  conferenceRecord?: string;
  pageSize?: string;
};

type SetupOptions = {
  json?: boolean;
};

type DoctorOptions = {
  json?: boolean;
  oauth?: boolean;
  meeting?: string;
  createSpace?: boolean;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  expiresAt?: string;
};

type JsonOptions = {
  json?: boolean;
};

type CreateOptions = {
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  expiresAt?: string;
  join?: boolean;
  transport?: GoogleMeetTransport;
  mode?: GoogleMeetMode;
  message?: string;
  dialInNumber?: string;
  pin?: string;
  dtmfSequence?: string;
  json?: boolean;
};

function writeStdoutJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeStdoutLine(...values: unknown[]): void {
  process.stdout.write(`${format(...values)}\n`);
}

async function promptInput(message: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a numeric value, received ${value}`);
  }
  return parsed;
}

function writeSetupStatus(status: Awaited<ReturnType<GoogleMeetRuntime["setupStatus"]>>): void {
  writeStdoutLine("Google Meet setup: %s", status.ok ? "OK" : "needs attention");
  for (const check of status.checks) {
    writeStdoutLine("[%s] %s: %s", check.ok ? "ok" : "fail", check.id, check.message);
  }
}

function formatBoolean(value: boolean | undefined): string {
  return typeof value === "boolean" ? (value ? "yes" : "no") : "unknown";
}

function formatOptional(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "n/a";
}

function writeDoctorStatus(status: ReturnType<GoogleMeetRuntime["status"]>): void {
  if (!status.found) {
    writeStdoutLine("Google Meet session: not found");
    return;
  }
  const sessions = status.session ? [status.session] : (status.sessions ?? []);
  if (sessions.length === 0) {
    writeStdoutLine("Google Meet sessions: none");
    return;
  }
  writeStdoutLine("Google Meet sessions: %d", sessions.length);
  for (const session of sessions) {
    const health = session.chrome?.health;
    writeStdoutLine("");
    writeStdoutLine("session: %s", session.id);
    writeStdoutLine("url: %s", session.url);
    writeStdoutLine("state: %s", session.state);
    writeStdoutLine("transport: %s", session.transport);
    writeStdoutLine("mode: %s", session.mode);
    writeStdoutLine("node: %s", session.chrome?.nodeId ?? "local/none");
    writeStdoutLine("audio bridge: %s", session.chrome?.audioBridge?.type ?? "none");
    writeStdoutLine(
      "provider: %s",
      session.chrome?.audioBridge?.provider ?? session.realtime.provider ?? "n/a",
    );
    writeStdoutLine("in call: %s", formatBoolean(health?.inCall));
    writeStdoutLine("manual action: %s", formatBoolean(health?.manualActionRequired));
    if (health?.manualActionRequired) {
      writeStdoutLine("manual reason: %s", formatOptional(health.manualActionReason));
      writeStdoutLine("manual message: %s", formatOptional(health.manualActionMessage));
    }
    writeStdoutLine("provider connected: %s", formatBoolean(health?.providerConnected));
    writeStdoutLine("realtime ready: %s", formatBoolean(health?.realtimeReady));
    writeStdoutLine("audio input active: %s", formatBoolean(health?.audioInputActive));
    writeStdoutLine("audio output active: %s", formatBoolean(health?.audioOutputActive));
    writeStdoutLine(
      "last input: %s (%s bytes)",
      formatOptional(health?.lastInputAt),
      health?.lastInputBytes ?? 0,
    );
    writeStdoutLine(
      "last output: %s (%s bytes)",
      formatOptional(health?.lastOutputAt),
      health?.lastOutputBytes ?? 0,
    );
    writeStdoutLine("bridge closed: %s", formatBoolean(health?.bridgeClosed));
    writeStdoutLine("browser url: %s", formatOptional(health?.browserUrl));
  }
}

type OAuthDoctorCheck = {
  id: string;
  ok: boolean;
  message: string;
};

type OAuthDoctorReport = {
  ok: boolean;
  configured: boolean;
  tokenSource?: "cached-access-token" | "refresh-token";
  expiresAt?: number;
  scope?: string;
  meetingUri?: string;
  createdSpace?: string;
  checks: OAuthDoctorCheck[];
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
  const checks: OAuthDoctorCheck[] = [];

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

function writeRecoverCurrentTabResult(
  result: Awaited<ReturnType<GoogleMeetRuntime["recoverCurrentTab"]>>,
): void {
  writeStdoutLine("Google Meet current tab: %s", result.found ? "found" : "not found");
  writeStdoutLine("node: %s", result.nodeId);
  if (result.targetId) {
    writeStdoutLine("target: %s", result.targetId);
  }
  if (result.tab?.url) {
    writeStdoutLine("tab url: %s", result.tab.url);
  }
  writeStdoutLine("message: %s", result.message);
  if (result.browser) {
    writeDoctorStatus({
      found: true,
      session: {
        id: "current-tab",
        url: result.browser.browserUrl ?? result.tab?.url ?? "unknown",
        transport: "chrome-node",
        mode: "transcribe",
        state: "active",
        createdAt: "",
        updatedAt: "",
        participantIdentity: "signed-in Google Chrome profile on a paired node",
        realtime: { enabled: false, toolPolicy: "safe-read-only" },
        chrome: {
          audioBackend: "blackhole-2ch",
          launched: true,
          nodeId: result.nodeId,
          health: result.browser,
        },
        notes: [],
      },
    });
  }
}

function resolveMeetingInput(config: GoogleMeetConfig, value?: string): string {
  const meeting = value?.trim() || config.defaults.meeting;
  if (!meeting) {
    throw new Error(
      "Meeting input is required. Pass a URL/meeting code or configure defaults.meeting.",
    );
  }
  return meeting;
}

function resolveTokenOptions(
  config: GoogleMeetConfig,
  options: ResolveSpaceOptions,
): {
  meeting: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
} {
  return {
    meeting: resolveMeetingInput(config, options.meeting),
    clientId: options.clientId?.trim() || config.oauth.clientId,
    clientSecret: options.clientSecret?.trim() || config.oauth.clientSecret,
    refreshToken: options.refreshToken?.trim() || config.oauth.refreshToken,
    accessToken: options.accessToken?.trim() || config.oauth.accessToken,
    expiresAt: parseOptionalNumber(options.expiresAt) ?? config.oauth.expiresAt,
  };
}

function resolveCreateTokenOptions(
  config: GoogleMeetConfig,
  options: CreateOptions,
): {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
} {
  return {
    clientId: options.clientId?.trim() || config.oauth.clientId,
    clientSecret: options.clientSecret?.trim() || config.oauth.clientSecret,
    refreshToken: options.refreshToken?.trim() || config.oauth.refreshToken,
    accessToken: options.accessToken?.trim() || config.oauth.accessToken,
    expiresAt: parseOptionalNumber(options.expiresAt) ?? config.oauth.expiresAt,
  };
}

function resolveArtifactTokenOptions(
  config: GoogleMeetConfig,
  options: MeetArtifactOptions,
): {
  meeting?: string;
  conferenceRecord?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  pageSize?: number;
} {
  const meeting = options.meeting?.trim() || config.defaults.meeting;
  const conferenceRecord = options.conferenceRecord?.trim();
  if (!meeting && !conferenceRecord) {
    throw new Error(
      "Meeting input or conference record is required. Pass --meeting, --conference-record, or configure defaults.meeting.",
    );
  }
  return {
    meeting,
    conferenceRecord,
    clientId: options.clientId?.trim() || config.oauth.clientId,
    clientSecret: options.clientSecret?.trim() || config.oauth.clientSecret,
    refreshToken: options.refreshToken?.trim() || config.oauth.refreshToken,
    accessToken: options.accessToken?.trim() || config.oauth.accessToken,
    expiresAt: parseOptionalNumber(options.expiresAt) ?? config.oauth.expiresAt,
    pageSize: parseOptionalNumber(options.pageSize),
  };
}

function hasCreateOAuth(config: GoogleMeetConfig, options: CreateOptions): boolean {
  return Boolean(
    options.accessToken?.trim() ||
    options.refreshToken?.trim() ||
    config.oauth.accessToken ||
    config.oauth.refreshToken,
  );
}

function writeArtifactsSummary(result: GoogleMeetArtifactsResult): void {
  if (result.input) {
    writeStdoutLine("input: %s", result.input);
  }
  if (result.space) {
    writeStdoutLine("space: %s", result.space.name);
  }
  writeStdoutLine("conference records: %d", result.conferenceRecords.length);
  for (const entry of result.artifacts) {
    writeStdoutLine("");
    writeStdoutLine("record: %s", entry.conferenceRecord.name);
    writeStdoutLine("started: %s", formatOptional(entry.conferenceRecord.startTime));
    writeStdoutLine("ended: %s", formatOptional(entry.conferenceRecord.endTime));
    writeStdoutLine("participants: %d", entry.participants.length);
    writeStdoutLine("recordings: %d", entry.recordings.length);
    writeStdoutLine("transcripts: %d", entry.transcripts.length);
    writeStdoutLine("smart notes: %d", entry.smartNotes.length);
    if (entry.smartNotesError) {
      writeStdoutLine("smart notes warning: %s", entry.smartNotesError);
    }
    for (const recording of entry.recordings) {
      writeStdoutLine("- recording: %s", recording.name);
    }
    for (const transcript of entry.transcripts) {
      writeStdoutLine("- transcript: %s", transcript.name);
    }
    for (const smartNote of entry.smartNotes) {
      writeStdoutLine("- smart note: %s", smartNote.name);
    }
  }
}

function writeAttendanceSummary(result: GoogleMeetAttendanceResult): void {
  if (result.input) {
    writeStdoutLine("input: %s", result.input);
  }
  if (result.space) {
    writeStdoutLine("space: %s", result.space.name);
  }
  writeStdoutLine("conference records: %d", result.conferenceRecords.length);
  writeStdoutLine("attendance rows: %d", result.attendance.length);
  for (const row of result.attendance) {
    const identity = row.displayName || row.user || row.participant;
    writeStdoutLine("");
    writeStdoutLine("participant: %s", identity);
    writeStdoutLine("record: %s", row.conferenceRecord);
    writeStdoutLine("resource: %s", row.participant);
    writeStdoutLine("first joined: %s", formatOptional(row.earliestStartTime));
    writeStdoutLine("last left: %s", formatOptional(row.latestEndTime));
    writeStdoutLine("sessions: %d", row.sessions.length);
    for (const session of row.sessions) {
      writeStdoutLine(
        "- %s: %s -> %s",
        session.name,
        formatOptional(session.startTime),
        formatOptional(session.endTime),
      );
    }
  }
}

export function registerGoogleMeetCli(params: {
  program: Command;
  config: GoogleMeetConfig;
  ensureRuntime: () => Promise<GoogleMeetRuntime>;
}) {
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
      const { verifier, challenge } = createGoogleMeetPkce();
      const state = createGoogleMeetOAuthState();
      const authUrl = buildGoogleMeetAuthUrl({
        clientId,
        challenge,
        state,
      });
      const code = await waitForGoogleMeetAuthCode({
        state,
        manual: Boolean(options.manual),
        timeoutMs: (parseOptionalNumber(options.timeoutSec) ?? 300) * 1000,
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

  root
    .command("create")
    .description("Create a new Google Meet space and print its meeting URL")
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--no-join", "Only create the meeting URL; do not join it")
    .option("--transport <transport>", "Join transport: chrome, chrome-node, or twilio")
    .option(
      "--mode <mode>",
      "Join mode: realtime for live talk-back, transcribe for observe/control",
    )
    .option("--message <text>", "Realtime speech to trigger after join")
    .option("--dial-in-number <phone>", "Meet dial-in number for Twilio transport")
    .option("--pin <pin>", "Meet phone PIN; # is appended if omitted")
    .option("--dtmf-sequence <sequence>", "Explicit Twilio DTMF sequence")
    .option("--json", "Print JSON output", false)
    .action(async (options: CreateOptions) => {
      if (!hasCreateOAuth(params.config, options)) {
        const rt = await params.ensureRuntime();
        const result = await rt.createViaBrowser();
        const join =
          options.join !== false
            ? await rt.join({
                url: result.meetingUri,
                transport: options.transport,
                mode: options.mode,
                message: options.message,
                dialInNumber: options.dialInNumber,
                pin: options.pin,
                dtmfSequence: options.dtmfSequence,
              })
            : undefined;
        const payload = {
          source: result.source,
          meetingUri: result.meetingUri,
          joined: Boolean(join),
          ...(join ? { join } : {}),
          browser: {
            nodeId: result.nodeId,
            targetId: result.targetId,
            browserUrl: result.browserUrl,
            browserTitle: result.browserTitle,
          },
        };
        if (options.json) {
          writeStdoutJson(payload);
          return;
        }
        writeStdoutLine("meeting uri: %s", result.meetingUri);
        writeStdoutLine("source: browser");
        writeStdoutLine("node: %s", result.nodeId);
        if (join) {
          writeStdoutLine("joined: %s", join.session.id);
        } else {
          writeStdoutLine("joined: no (run `openclaw googlemeet join %s`)", result.meetingUri);
        }
        return;
      }
      const token = await resolveGoogleMeetAccessToken(
        resolveCreateTokenOptions(params.config, options),
      );
      const result = await createGoogleMeetSpace({ accessToken: token.accessToken });
      const join =
        options.join !== false
          ? await (
              await params.ensureRuntime()
            ).join({
              url: result.meetingUri,
              transport: options.transport,
              mode: options.mode,
              message: options.message,
              dialInNumber: options.dialInNumber,
              pin: options.pin,
              dtmfSequence: options.dtmfSequence,
            })
          : undefined;
      if (options.json) {
        writeStdoutJson({
          ...result,
          tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
          joined: Boolean(join),
          ...(join ? { join } : {}),
        });
        return;
      }
      writeStdoutLine("meeting uri: %s", result.meetingUri);
      writeStdoutLine("space: %s", result.space.name);
      if (result.space.meetingCode) {
        writeStdoutLine("meeting code: %s", result.space.meetingCode);
      }
      writeStdoutLine(
        "token source: %s",
        token.refreshed ? "refresh-token" : "cached-access-token",
      );
      if (join) {
        writeStdoutLine("joined: %s", join.session.id);
      } else {
        writeStdoutLine("joined: no (run `openclaw googlemeet join %s`)", result.meetingUri);
      }
    });

  root
    .command("join")
    .argument("[url]", "Explicit https://meet.google.com/... URL")
    .option("--transport <transport>", "Transport: chrome, chrome-node, or twilio")
    .option(
      "--mode <mode>",
      "Mode: realtime for live talk-back, transcribe to join without the realtime voice bridge",
    )
    .option("--message <text>", "Realtime speech to trigger after join")
    .option("--dial-in-number <phone>", "Meet dial-in number for Twilio transport")
    .option("--pin <pin>", "Meet phone PIN; # is appended if omitted")
    .option("--dtmf-sequence <sequence>", "Explicit Twilio DTMF sequence")
    .action(async (url: string | undefined, options: JoinOptions) => {
      const rt = await params.ensureRuntime();
      const result = await rt.join({
        url: resolveMeetingInput(params.config, url),
        transport: options.transport,
        mode: options.mode,
        message: options.message,
        dialInNumber: options.dialInNumber,
        pin: options.pin,
        dtmfSequence: options.dtmfSequence,
      });
      writeStdoutJson(result.session);
    });

  root
    .command("test-speech")
    .argument("[url]", "Explicit https://meet.google.com/... URL")
    .option("--transport <transport>", "Transport: chrome, chrome-node, or twilio")
    .option(
      "--mode <mode>",
      "Mode: realtime for live talk-back, transcribe to join without the realtime voice bridge",
    )
    .option(
      "--message <text>",
      "Realtime speech to trigger",
      "Say exactly: Google Meet speech test complete.",
    )
    .action(async (url: string | undefined, options: JoinOptions) => {
      const rt = await params.ensureRuntime();
      writeStdoutJson(
        await rt.testSpeech({
          url: resolveMeetingInput(params.config, url),
          transport: options.transport,
          mode: options.mode,
          message: options.message,
        }),
      );
    });

  root
    .command("resolve-space")
    .description("Resolve a Meet URL, meeting code, or spaces/{id} to its canonical space")
    .option("--meeting <value>", "Meet URL, meeting code, or spaces/{id}")
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--json", "Print JSON output", false)
    .action(async (options: ResolveSpaceOptions) => {
      const resolved = resolveTokenOptions(params.config, options);
      const token = await resolveGoogleMeetAccessToken(resolved);
      const space = await fetchGoogleMeetSpace({
        accessToken: token.accessToken,
        meeting: resolved.meeting,
      });
      if (options.json) {
        writeStdoutJson(space);
        return;
      }
      writeStdoutLine("input: %s", resolved.meeting);
      writeStdoutLine("space: %s", space.name);
      if (space.meetingCode) {
        writeStdoutLine("meeting code: %s", space.meetingCode);
      }
      if (space.meetingUri) {
        writeStdoutLine("meeting uri: %s", space.meetingUri);
      }
      writeStdoutLine("active conference: %s", space.activeConference ? "yes" : "no");
      writeStdoutLine(
        "token source: %s",
        token.refreshed ? "refresh-token" : "cached-access-token",
      );
    });

  root
    .command("preflight")
    .description("Validate OAuth + meeting resolution prerequisites for Meet media work")
    .option("--meeting <value>", "Meet URL, meeting code, or spaces/{id}")
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--json", "Print JSON output", false)
    .action(async (options: ResolveSpaceOptions) => {
      const resolved = resolveTokenOptions(params.config, options);
      const token = await resolveGoogleMeetAccessToken(resolved);
      const space = await fetchGoogleMeetSpace({
        accessToken: token.accessToken,
        meeting: resolved.meeting,
      });
      const report = buildGoogleMeetPreflightReport({
        input: resolved.meeting,
        space,
        previewAcknowledged: params.config.preview.enrollmentAcknowledged,
        tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
      });
      if (options.json) {
        writeStdoutJson(report);
        return;
      }
      writeStdoutLine("input: %s", report.input);
      writeStdoutLine("resolved space: %s", report.resolvedSpaceName);
      if (report.meetingCode) {
        writeStdoutLine("meeting code: %s", report.meetingCode);
      }
      if (report.meetingUri) {
        writeStdoutLine("meeting uri: %s", report.meetingUri);
      }
      writeStdoutLine("active conference: %s", report.hasActiveConference ? "yes" : "no");
      writeStdoutLine("preview acknowledged: %s", report.previewAcknowledged ? "yes" : "no");
      writeStdoutLine("token source: %s", report.tokenSource);
      if (report.blockers.length === 0) {
        writeStdoutLine("blockers: none");
        return;
      }
      writeStdoutLine("blockers:");
      for (const blocker of report.blockers) {
        writeStdoutLine("- %s", blocker);
      }
    });

  root
    .command("artifacts")
    .description("List Meet conference records and available participant/artifact metadata")
    .option("--meeting <value>", "Meet URL, meeting code, or spaces/{id}")
    .option("--conference-record <name>", "Conference record name or id")
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--page-size <n>", "Max resources per Meet API page")
    .option("--json", "Print JSON output", false)
    .action(async (options: MeetArtifactOptions) => {
      const resolved = resolveArtifactTokenOptions(params.config, options);
      const token = await resolveGoogleMeetAccessToken(resolved);
      const result = await fetchGoogleMeetArtifacts({
        accessToken: token.accessToken,
        meeting: resolved.meeting,
        conferenceRecord: resolved.conferenceRecord,
        pageSize: resolved.pageSize,
      });
      if (options.json) {
        writeStdoutJson({
          ...result,
          tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
        });
        return;
      }
      writeArtifactsSummary(result);
      writeStdoutLine(
        "token source: %s",
        token.refreshed ? "refresh-token" : "cached-access-token",
      );
    });

  root
    .command("attendance")
    .description("List Meet participants and participant sessions")
    .option("--meeting <value>", "Meet URL, meeting code, or spaces/{id}")
    .option("--conference-record <name>", "Conference record name or id")
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--page-size <n>", "Max resources per Meet API page")
    .option("--json", "Print JSON output", false)
    .action(async (options: MeetArtifactOptions) => {
      const resolved = resolveArtifactTokenOptions(params.config, options);
      const token = await resolveGoogleMeetAccessToken(resolved);
      const result = await fetchGoogleMeetAttendance({
        accessToken: token.accessToken,
        meeting: resolved.meeting,
        conferenceRecord: resolved.conferenceRecord,
        pageSize: resolved.pageSize,
      });
      if (options.json) {
        writeStdoutJson({
          ...result,
          tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
        });
        return;
      }
      writeAttendanceSummary(result);
      writeStdoutLine(
        "token source: %s",
        token.refreshed ? "refresh-token" : "cached-access-token",
      );
    });

  root
    .command("status")
    .argument("[session-id]", "Meet session ID")
    .action(async (sessionId?: string) => {
      const rt = await params.ensureRuntime();
      writeStdoutJson(rt.status(sessionId));
    });

  root
    .command("doctor")
    .description("Show human-readable Meet session/browser/realtime health")
    .argument("[session-id]", "Meet session ID")
    .option("--oauth", "Verify Google Meet OAuth token refresh without printing secrets", false)
    .option("--meeting <value>", "Also verify spaces.get for a Meet URL, code, or spaces/{id}")
    .option("--create-space", "Also verify spaces.create by creating a throwaway Meet space", false)
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--json", "Print JSON output", false)
    .action(async (sessionId: string | undefined, options: DoctorOptions) => {
      if (options.oauth) {
        const report = await buildOAuthDoctorReport(params.config, options);
        if (options.json) {
          writeStdoutJson(report);
          return;
        }
        writeOAuthDoctorReport(report);
        return;
      }
      const rt = await params.ensureRuntime();
      const status = rt.status(sessionId);
      if (options.json) {
        writeStdoutJson(status);
        return;
      }
      writeDoctorStatus(status);
    });

  root
    .command("recover-tab")
    .description("Focus and inspect an existing Google Meet tab on the Chrome node")
    .argument("[url]", "Optional Meet URL to match")
    .option("--json", "Print JSON output", false)
    .action(async (url: string | undefined, options: JsonOptions) => {
      const rt = await params.ensureRuntime();
      const result = await rt.recoverCurrentTab({ url });
      if (options.json) {
        writeStdoutJson(result);
        return;
      }
      writeRecoverCurrentTabResult(result);
    });

  root
    .command("setup")
    .description("Show Google Meet transport setup status")
    .option("--json", "Print JSON output", false)
    .action(async (options: SetupOptions) => {
      const rt = await params.ensureRuntime();
      const status = await rt.setupStatus();
      if (options.json) {
        writeStdoutJson(status);
        return;
      }
      writeSetupStatus(status);
    });

  root
    .command("leave")
    .argument("<session-id>", "Meet session ID")
    .action(async (sessionId: string) => {
      const rt = await params.ensureRuntime();
      const result = await rt.leave(sessionId);
      if (!result.found) {
        throw new Error("session not found");
      }
      writeStdoutLine("left %s", sessionId);
    });

  root
    .command("speak")
    .argument("<session-id>", "Meet session ID")
    .argument("[message]", "Realtime instructions to speak now")
    .action(async (sessionId: string, message?: string) => {
      const rt = await params.ensureRuntime();
      const result = rt.speak(sessionId, message);
      if (!result.found) {
        throw new Error("session not found");
      }
      if (!result.spoken) {
        throw new Error("session has no active realtime audio bridge");
      }
      writeStdoutLine("speaking on %s", sessionId);
    });
}
