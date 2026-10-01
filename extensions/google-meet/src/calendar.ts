import { parseDateStringTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { requestGoogleApi } from "./google-api.js";
import { normalizeMeetUrl } from "./meet-url.js";

const GOOGLE_CALENDAR_API_BASE_URL = "https://www.googleapis.com/calendar/v3";
const GOOGLE_CALENDAR_API_HOST = "www.googleapis.com";
const GOOGLE_CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";

type GoogleCalendarEventDate = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

type GoogleCalendarConferenceEntryPoint = {
  entryPointType?: string;
  uri?: string;
  label?: string;
};

type GoogleMeetCalendarEvent = {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: GoogleCalendarEventDate;
  end?: GoogleCalendarEventDate;
  conferenceData?: {
    conferenceId?: string;
    conferenceSolution?: {
      key?: { type?: string };
      name?: string;
    };
    entryPoints?: GoogleCalendarConferenceEntryPoint[];
  };
};

export type GoogleMeetCalendarLookupResult = {
  calendarId: string;
  event: GoogleMeetCalendarEvent;
  meetingUri: string;
};

type GoogleMeetCalendarEventsResult = {
  calendarId: string;
  events: Array<{
    event: GoogleMeetCalendarEvent;
    meetingUri: string;
    selected: boolean;
  }>;
};

function normalizeGoogleMeetCalendarUri(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    if (
      url.hostname.toLowerCase() !== "meet.google.com" ||
      url.port ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    // Calendar entry points may use HTTP. Upgrade before passing the URL to the
    // stricter runtime boundary so browser and node-host navigation stay HTTPS-only.
    url.protocol = "https:";
    return normalizeMeetUrl(url.toString());
  } catch {
    return undefined;
  }
}

function extractGoogleMeetUriFromText(value: string | undefined): string | undefined {
  const matches = value?.matchAll(/https:\/\/meet\.google\.com\/[a-z0-9-]+/gi);
  for (const match of matches ?? []) {
    const uri = normalizeGoogleMeetCalendarUri(match[0]);
    if (uri) {
      return uri;
    }
  }
  return undefined;
}

function findFirstGoogleMeetCalendarUri(
  entryPoints: GoogleCalendarConferenceEntryPoint[],
  predicate: (entry: GoogleCalendarConferenceEntryPoint) => boolean = () => true,
): string | undefined {
  for (const entry of entryPoints) {
    if (!predicate(entry)) {
      continue;
    }
    const uri = normalizeGoogleMeetCalendarUri(entry.uri);
    if (uri) {
      return uri;
    }
  }
  return undefined;
}

function extractGoogleMeetUriFromCalendarEvent(event: GoogleMeetCalendarEvent): string | undefined {
  const hangoutLink = normalizeGoogleMeetCalendarUri(event.hangoutLink);
  if (hangoutLink) {
    return hangoutLink;
  }
  const entryPoints = event.conferenceData?.entryPoints ?? [];
  return (
    findFirstGoogleMeetCalendarUri(entryPoints, (entry) => entry.entryPointType === "video") ??
    findFirstGoogleMeetCalendarUri(entryPoints) ??
    extractGoogleMeetUriFromText(event.location) ??
    extractGoogleMeetUriFromText(event.description)
  );
}

export function buildGoogleMeetCalendarDayWindow(now = new Date()): {
  timeMin: string;
  timeMax: string;
} {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

function rankCalendarEvent(event: GoogleMeetCalendarEvent, nowMs: number): number {
  const startMs =
    parseDateStringTimestampMs(event.start?.dateTime ?? event.start?.date) ??
    Number.POSITIVE_INFINITY;
  const endMs = parseDateStringTimestampMs(event.end?.dateTime ?? event.end?.date) ?? startMs;
  if (startMs <= nowMs && endMs >= nowMs) {
    return 0;
  }
  if (startMs > nowMs) {
    return startMs - nowMs;
  }
  return nowMs - startMs + 30 * 24 * 60 * 60 * 1000;
}

function chooseBestMeetCalendarEvent(
  events: GoogleMeetCalendarEvent[],
  now: Date,
): GoogleMeetCalendarLookupResult["event"] | undefined {
  const nowMs = now.getTime();
  let selected: GoogleMeetCalendarEvent | undefined;
  let selectedRank = Number.POSITIVE_INFINITY;
  for (const event of events) {
    if (event.status === "cancelled" || !extractGoogleMeetUriFromCalendarEvent(event)) {
      continue;
    }
    const rank = rankCalendarEvent(event, nowMs);
    if (!selected || rank < selectedRank) {
      selected = event;
      selectedRank = rank;
    }
  }
  return selected;
}

type GoogleMeetCalendarQuery = {
  accessToken: string;
  calendarId?: string;
  eventQuery?: string;
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
  now?: Date;
};

async function fetchGoogleCalendarEvents(
  params: GoogleMeetCalendarQuery,
): Promise<{ calendarId: string; events: GoogleMeetCalendarEvent[]; now: Date }> {
  const calendarId = params.calendarId?.trim() || "primary";
  const now = params.now ?? new Date();
  const defaultTimeMax = new Date(now);
  defaultTimeMax.setDate(defaultTimeMax.getDate() + 7);
  return requestGoogleApi(
    {
      url: `${GOOGLE_CALENDAR_API_BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events`,
      query: {
        maxResults: params.maxResults ?? 50,
        orderBy: "startTime",
        q: params.eventQuery?.trim() || undefined,
        showDeleted: false,
        singleEvents: true,
        timeMin: params.timeMin ?? now.toISOString(),
        timeMax: params.timeMax ?? defaultTimeMax.toISOString(),
      },
      accessToken: params.accessToken,
      allowedHostname: GOOGLE_CALENDAR_API_HOST,
      auditContext: "google-meet.calendar.events.list",
      prefix: "Google Calendar events.list",
      scopes: [GOOGLE_CALENDAR_EVENTS_SCOPE],
    },
    async (response) => {
      const payload = await readProviderJsonResponse<{ items?: unknown }>(
        response,
        "Google Calendar events.list",
      );
      if (payload.items !== undefined && !Array.isArray(payload.items)) {
        throw new Error("Google Calendar events.list response had non-array items");
      }
      return { calendarId, events: (payload.items ?? []) as GoogleMeetCalendarEvent[], now };
    },
  );
}

export async function listGoogleMeetCalendarEvents(
  params: GoogleMeetCalendarQuery,
): Promise<GoogleMeetCalendarEventsResult> {
  const { calendarId, events, now } = await fetchGoogleCalendarEvents(params);
  const best = chooseBestMeetCalendarEvent(events, now);
  return {
    calendarId,
    events: events
      .map((event) => {
        const meetingUri = extractGoogleMeetUriFromCalendarEvent(event);
        return meetingUri ? { event, meetingUri, selected: event === best } : undefined;
      })
      .filter((event): event is GoogleMeetCalendarEventsResult["events"][number] => Boolean(event)),
  };
}

export async function findGoogleMeetCalendarEvent(
  params: GoogleMeetCalendarQuery,
): Promise<GoogleMeetCalendarLookupResult> {
  const result = await listGoogleMeetCalendarEvents(params);
  const selected = result.events.find((event) => event.selected) ?? result.events[0];
  if (!selected) {
    throw new Error("No Google Calendar event with a Google Meet link matched the query");
  }
  return {
    calendarId: result.calendarId,
    event: selected.event,
    meetingUri: selected.meetingUri,
  };
}
