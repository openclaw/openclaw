import type { Command } from "commander";
import type { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import {
  callGoogleMeetGateway,
  parseOptionalNumber,
  type ResolveSpaceOptions,
} from "./cli-shared.js";
import type { GoogleMeetConfig } from "./config.js";
import type { GoogleMeetRuntime } from "./runtime.js";

export function addGoogleMeetOAuthOptions(command: Command): Command {
  return command
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds");
}

export function addGoogleMeetMeetingOption(command: Command): Command {
  return command.option("--meeting <value>", "Meet URL, meeting code, or spaces/{id}");
}

export function addGoogleMeetCalendarOptions(command: Command): Command {
  return command
    .option("--today", "Find a Meet link on today's calendar")
    .option("--event <query>", "Find a matching calendar event with a Meet link")
    .option("--calendar <id>", "Calendar id for --today or --event", "primary");
}

export function addGoogleMeetArtifactOptions(command: Command): Command {
  const withMeeting = addGoogleMeetMeetingOption(command).option(
    "--conference-record <name>",
    "Conference record name or id",
  );
  return addGoogleMeetOAuthOptions(addGoogleMeetCalendarOptions(withMeeting))
    .option("--page-size <n>", "Max resources per Meet API page")
    .option("--all-conference-records", "Fetch every conference record for --meeting");
}

export type GoogleMeetCliCommandContext = {
  root: Command;
  config: GoogleMeetConfig;
  ensureRuntime: () => Promise<GoogleMeetRuntime>;
  callGateway: typeof callGatewayFromCli;
  operationTimeoutMs: number;
};

export function resolveCliMeetingInput(config: GoogleMeetConfig, value?: string): string {
  const meeting = value?.trim() || config.defaults.meeting;
  if (!meeting) {
    throw new Error(
      "Meeting input is required. Pass a URL/meeting code or configure defaults.meeting.",
    );
  }
  return meeting;
}

export function resolveCliParams(options: ResolveSpaceOptions) {
  const { calendar, expiresAt, ...raw } = options;
  return { ...raw, calendarId: calendar, expiresAt: parseOptionalNumber(expiresAt) };
}

export async function callGoogleMeetRuntime<Result>(
  context: GoogleMeetCliCommandContext,
  method: Parameters<typeof callGoogleMeetGateway>[0]["method"],
  payload: Record<string, unknown>,
  local: (runtime: GoogleMeetRuntime) => Promise<Result>,
  timeoutMs?: number,
): Promise<Result> {
  const delegated = await callGoogleMeetGateway({
    callGateway: context.callGateway,
    method,
    payload,
    timeoutMs,
  });
  // SAFETY: Each method's gateway handler returns the same Result as the paired local runtime call.
  return delegated.ok ? (delegated.payload as Result) : local(await context.ensureRuntime());
}
