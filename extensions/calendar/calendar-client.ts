/**
 * Thin wrapper around Google Calendar v3. Methods are 1:1 with the agent
 * tools so the index.ts entry point stays declarative.
 */

import { OAuth2Client } from "google-auth-library";
import { calendar_v3, google } from "googleapis";

export type CalEvent = {
  id: string;
  summary: string;
  description: string;
  location: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees: Array<{ email: string; responseStatus?: string }>;
  htmlLink: string;
  status: string;
};

export type FreeBusyBlock = {
  start: string;
  end: string;
};

export class CalendarClient {
  private readonly cal: calendar_v3.Calendar;
  private readonly oauth: OAuth2Client;

  constructor(opts: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }) {
    this.oauth = new google.auth.OAuth2(opts.clientId, opts.clientSecret);
    this.oauth.setCredentials({ refresh_token: opts.refreshToken });
    this.cal = google.calendar({ version: "v3", auth: this.oauth });
  }

  async listEvents(opts: {
    calendarId: string;
    timeMinIso: string;
    timeMaxIso: string;
    q?: string;
    maxResults?: number;
  }): Promise<CalEvent[]> {
    const res = await this.cal.events.list({
      calendarId: opts.calendarId,
      timeMin: opts.timeMinIso,
      timeMax: opts.timeMaxIso,
      q: opts.q,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: opts.maxResults ?? 50,
    });
    return (res.data.items ?? []).map(toCalEvent);
  }

  async getEvent(opts: { calendarId: string; eventId: string }): Promise<CalEvent | null> {
    try {
      const res = await this.cal.events.get({
        calendarId: opts.calendarId,
        eventId: opts.eventId,
      });
      return toCalEvent(res.data);
    } catch (err) {
      if ((err as { code?: number }).code === 404) {
        return null;
      }
      throw err;
    }
  }

  async createEvent(opts: {
    calendarId: string;
    summary: string;
    description?: string;
    location?: string;
    startIso: string;
    endIso: string;
    timezone: string;
    attendees?: string[];
    sendUpdates?: "all" | "externalOnly" | "none";
  }): Promise<CalEvent> {
    const res = await this.cal.events.insert({
      calendarId: opts.calendarId,
      sendUpdates: opts.sendUpdates ?? "none",
      requestBody: {
        summary: opts.summary,
        description: opts.description,
        location: opts.location,
        start: { dateTime: opts.startIso, timeZone: opts.timezone },
        end: { dateTime: opts.endIso, timeZone: opts.timezone },
        attendees: opts.attendees?.map((email) => ({ email })),
      },
    });
    return toCalEvent(res.data);
  }

  /**
   * Use Google's natural-language quick-add. Accepts strings like
   * "Lunch with Sarah next Tuesday 1pm at Noma".
   */
  async quickAdd(opts: { calendarId: string; text: string }): Promise<CalEvent> {
    const res = await this.cal.events.quickAdd({
      calendarId: opts.calendarId,
      text: opts.text,
    });
    return toCalEvent(res.data);
  }

  async updateEvent(opts: {
    calendarId: string;
    eventId: string;
    patch: {
      summary?: string;
      description?: string;
      location?: string;
      startIso?: string;
      endIso?: string;
      timezone?: string;
      attendees?: string[];
    };
    sendUpdates?: "all" | "externalOnly" | "none";
  }): Promise<CalEvent> {
    const requestBody: calendar_v3.Schema$Event = {};
    const p = opts.patch;
    if (p.summary !== undefined) requestBody.summary = p.summary;
    if (p.description !== undefined) requestBody.description = p.description;
    if (p.location !== undefined) requestBody.location = p.location;
    if (p.startIso) {
      requestBody.start = { dateTime: p.startIso, timeZone: p.timezone };
    }
    if (p.endIso) {
      requestBody.end = { dateTime: p.endIso, timeZone: p.timezone };
    }
    if (p.attendees) {
      requestBody.attendees = p.attendees.map((email) => ({ email }));
    }

    const res = await this.cal.events.patch({
      calendarId: opts.calendarId,
      eventId: opts.eventId,
      sendUpdates: opts.sendUpdates ?? "none",
      requestBody,
    });
    return toCalEvent(res.data);
  }

  async deleteEvent(opts: {
    calendarId: string;
    eventId: string;
    sendUpdates?: "all" | "externalOnly" | "none";
  }): Promise<void> {
    await this.cal.events.delete({
      calendarId: opts.calendarId,
      eventId: opts.eventId,
      sendUpdates: opts.sendUpdates ?? "none",
    });
  }

  /**
   * Use the freeBusy endpoint to find gaps long enough for `durationMinutes`
   * within the given window. Returns up to `limit` candidate slots.
   */
  async findFreeSlots(opts: {
    calendarIds: string[];
    timeMinIso: string;
    timeMaxIso: string;
    timezone: string;
    durationMinutes: number;
    limit?: number;
    workingDayStartHour?: number;
    workingDayEndHour?: number;
  }): Promise<FreeBusyBlock[]> {
    const res = await this.cal.freebusy.query({
      requestBody: {
        timeMin: opts.timeMinIso,
        timeMax: opts.timeMaxIso,
        timeZone: opts.timezone,
        items: opts.calendarIds.map((id) => ({ id })),
      },
    });

    const busy: FreeBusyBlock[] = [];
    const calendars = res.data.calendars ?? {};
    for (const id of opts.calendarIds) {
      const blocks = calendars[id]?.busy ?? [];
      for (const b of blocks) {
        if (b.start && b.end) busy.push({ start: b.start, end: b.end });
      }
    }
    busy.sort((a, b) => a.start.localeCompare(b.start));

    // Merge overlapping busy blocks
    const merged: FreeBusyBlock[] = [];
    for (const b of busy) {
      const last = merged[merged.length - 1];
      if (last && b.start <= last.end) {
        last.end = b.end > last.end ? b.end : last.end;
      } else {
        merged.push({ ...b });
      }
    }

    // Walk gaps between busy blocks within the requested window
    const windowStart = new Date(opts.timeMinIso).getTime();
    const windowEnd = new Date(opts.timeMaxIso).getTime();
    const durationMs = opts.durationMinutes * 60_000;
    const dayStart = opts.workingDayStartHour ?? 9;
    const dayEnd = opts.workingDayEndHour ?? 18;
    const limit = opts.limit ?? 5;

    const free: FreeBusyBlock[] = [];
    let cursor = windowStart;

    const addIfFits = (startMs: number, endMs: number) => {
      if (free.length >= limit) return;
      // Clip to working hours per local day
      const startD = new Date(startMs);
      const endD = new Date(endMs);
      // If span crosses days, split per day
      while (startD < endD && free.length < limit) {
        const dayStartLocal = new Date(startD);
        dayStartLocal.setHours(dayStart, 0, 0, 0);
        const dayEndLocal = new Date(startD);
        dayEndLocal.setHours(dayEnd, 0, 0, 0);
        const slotStart = startD < dayStartLocal ? dayStartLocal : startD;
        const slotEnd = endD < dayEndLocal ? endD : dayEndLocal;
        if (slotEnd.getTime() - slotStart.getTime() >= durationMs) {
          free.push({
            start: slotStart.toISOString(),
            end: new Date(slotStart.getTime() + durationMs).toISOString(),
          });
        }
        // Advance to next day at dayStart
        startD.setDate(startD.getDate() + 1);
        startD.setHours(dayStart, 0, 0, 0);
      }
    };

    for (const b of merged) {
      const busyStart = new Date(b.start).getTime();
      if (busyStart - cursor >= durationMs) {
        addIfFits(cursor, busyStart);
      }
      cursor = Math.max(cursor, new Date(b.end).getTime());
    }
    if (windowEnd - cursor >= durationMs) {
      addIfFits(cursor, windowEnd);
    }
    return free;
  }
}

function toCalEvent(e: calendar_v3.Schema$Event): CalEvent {
  return {
    id: e.id ?? "",
    summary: e.summary ?? "(no title)",
    description: e.description ?? "",
    location: e.location ?? "",
    start: {
      dateTime: e.start?.dateTime ?? undefined,
      date: e.start?.date ?? undefined,
      timeZone: e.start?.timeZone ?? undefined,
    },
    end: {
      dateTime: e.end?.dateTime ?? undefined,
      date: e.end?.date ?? undefined,
      timeZone: e.end?.timeZone ?? undefined,
    },
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.email ?? "",
      responseStatus: a.responseStatus ?? undefined,
    })),
    htmlLink: e.htmlLink ?? "",
    status: e.status ?? "",
  };
}
