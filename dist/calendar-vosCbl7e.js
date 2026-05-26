import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import "./ssrf-runtime-Be2o3zD7.js";
import { _ as googleApiError } from "./chrome-create-D3QLc7OZ.js";
//#region extensions/google-meet/src/calendar.ts
const GOOGLE_CALENDAR_API_BASE_URL = "https://www.googleapis.com/calendar/v3";
const GOOGLE_CALENDAR_API_HOST = "www.googleapis.com";
const GOOGLE_MEET_URL_HOST = "meet.google.com";
const GOOGLE_CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
function appendQuery(url, query) {
	const parsed = new URL(url);
	for (const [key, value] of Object.entries(query)) if (value !== void 0) parsed.searchParams.set(key, String(value));
	return parsed.toString();
}
function isGoogleMeetUri(value) {
	if (!value?.trim()) return false;
	try {
		return new URL(value).hostname === GOOGLE_MEET_URL_HOST;
	} catch {
		return false;
	}
}
function extractGoogleMeetUriFromText(value) {
	return (value?.match(/https:\/\/meet\.google\.com\/[a-z0-9-]+/i))?.[0];
}
function extractGoogleMeetUriFromCalendarEvent(event) {
	if (isGoogleMeetUri(event.hangoutLink)) return event.hangoutLink;
	const entryPoints = event.conferenceData?.entryPoints ?? [];
	const videoEntry = entryPoints.find((entry) => entry.entryPointType === "video" && isGoogleMeetUri(entry.uri));
	if (videoEntry?.uri) return videoEntry.uri;
	const meetEntry = entryPoints.find((entry) => isGoogleMeetUri(entry.uri));
	if (meetEntry?.uri) return meetEntry.uri;
	return extractGoogleMeetUriFromText(event.location) ?? extractGoogleMeetUriFromText(event.description);
}
function buildGoogleMeetCalendarDayWindow(now = /* @__PURE__ */ new Date()) {
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	const end = new Date(start);
	end.setDate(start.getDate() + 1);
	return {
		timeMin: start.toISOString(),
		timeMax: end.toISOString()
	};
}
function parseCalendarEventTime(value) {
	const raw = value?.dateTime ?? value?.date;
	if (!raw) return;
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function rankCalendarEvent(event, nowMs) {
	const startMs = parseCalendarEventTime(event.start) ?? Number.POSITIVE_INFINITY;
	const endMs = parseCalendarEventTime(event.end) ?? startMs;
	if (startMs <= nowMs && endMs >= nowMs) return 0;
	if (startMs > nowMs) return startMs - nowMs;
	return nowMs - startMs + 720 * 60 * 60 * 1e3;
}
function chooseBestMeetCalendarEvent(events, now) {
	const nowMs = now.getTime();
	let selected;
	let selectedRank = Number.POSITIVE_INFINITY;
	for (const event of events) {
		if (event.status === "cancelled" || !extractGoogleMeetUriFromCalendarEvent(event)) continue;
		const rank = rankCalendarEvent(event, nowMs);
		if (!selected || rank < selectedRank) {
			selected = event;
			selectedRank = rank;
		}
	}
	return selected;
}
async function fetchGoogleCalendarEvents(params) {
	const calendarId = params.calendarId?.trim() || "primary";
	const now = params.now ?? /* @__PURE__ */ new Date();
	const defaultTimeMax = new Date(now);
	defaultTimeMax.setDate(defaultTimeMax.getDate() + 7);
	const { response, release } = await fetchWithSsrFGuard({
		url: appendQuery(`${GOOGLE_CALENDAR_API_BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events`, {
			maxResults: params.maxResults ?? 50,
			orderBy: "startTime",
			q: params.eventQuery?.trim() || void 0,
			showDeleted: false,
			singleEvents: true,
			timeMin: params.timeMin ?? now.toISOString(),
			timeMax: params.timeMax ?? defaultTimeMax.toISOString()
		}),
		init: { headers: {
			Authorization: `Bearer ${params.accessToken}`,
			Accept: "application/json"
		} },
		policy: { allowedHostnames: [GOOGLE_CALENDAR_API_HOST] },
		auditContext: "google-meet.calendar.events.list"
	});
	try {
		if (!response.ok) throw await googleApiError({
			response,
			detail: await response.text(),
			prefix: "Google Calendar events.list",
			scopes: [GOOGLE_CALENDAR_EVENTS_SCOPE]
		});
		const payload = await response.json();
		if (payload.items !== void 0 && !Array.isArray(payload.items)) throw new Error("Google Calendar events.list response had non-array items");
		return {
			calendarId,
			events: payload.items ?? [],
			now
		};
	} finally {
		await release();
	}
}
async function listGoogleMeetCalendarEvents(params) {
	const { calendarId, events, now } = await fetchGoogleCalendarEvents(params);
	const best = chooseBestMeetCalendarEvent(events, now);
	return {
		calendarId,
		events: events.map((event) => {
			const meetingUri = extractGoogleMeetUriFromCalendarEvent(event);
			return meetingUri ? {
				event,
				meetingUri,
				selected: event === best
			} : void 0;
		}).filter((event) => Boolean(event))
	};
}
async function findGoogleMeetCalendarEvent(params) {
	const result = await listGoogleMeetCalendarEvents(params);
	const selected = result.events.find((event) => event.selected) ?? result.events[0];
	if (!selected) throw new Error("No Google Calendar event with a Google Meet link matched the query");
	return {
		calendarId: result.calendarId,
		event: selected.event,
		meetingUri: selected.meetingUri
	};
}
//#endregion
export { findGoogleMeetCalendarEvent as n, listGoogleMeetCalendarEvents as r, buildGoogleMeetCalendarDayWindow as t };
