/**
 * Config schema for the calendar plugin. Reuses the same Google OAuth
 * client as inbox-triage — the user just re-runs the auth helper with
 * both Gmail and Calendar scopes selected to produce a single refresh
 * token that works for both.
 */

export type CalendarConfig = {
  google: {
    user: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
  defaultCalendarId: string;
  timezone: string;
  writeEnabled: boolean;
};

const DEFAULT_CALENDAR_ID = "primary";
const DEFAULT_TIMEZONE = "Europe/London";

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar: string) => {
    const envValue = process.env[envVar];
    if (envValue === undefined || envValue === "") {
      throw new Error(`calendar: required env var ${envVar} is not set`);
    }
    return envValue;
  });
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`calendar: ${label} is required`);
  }
  return value;
}

export const calendarConfigSchema = {
  parse(value: unknown): CalendarConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("calendar: config required");
    }
    const cfg = value as Record<string, unknown>;
    const google = cfg.google as Record<string, unknown> | undefined;
    if (!google) {
      throw new Error("calendar: google config is required");
    }

    return {
      google: {
        user: resolveEnvVars(asString(google.user, "google.user")),
        clientId: resolveEnvVars(asString(google.clientId, "google.clientId")),
        clientSecret: resolveEnvVars(asString(google.clientSecret, "google.clientSecret")),
        refreshToken: resolveEnvVars(asString(google.refreshToken, "google.refreshToken")),
      },
      defaultCalendarId:
        typeof cfg.defaultCalendarId === "string" && cfg.defaultCalendarId.length > 0
          ? cfg.defaultCalendarId
          : DEFAULT_CALENDAR_ID,
      timezone:
        typeof cfg.timezone === "string" && cfg.timezone.length > 0
          ? cfg.timezone
          : DEFAULT_TIMEZONE,
      writeEnabled: cfg.writeEnabled !== false,
    };
  },
};
