/**
 * Google Calendar tool definitions for Anthropic tool_use during voice calls.
 * Executes calendar operations via the `gog` CLI.
 */

import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Tool definitions (Anthropic Messages API format)
// ---------------------------------------------------------------------------

export const CALENDAR_TOOLS = [
  {
    name: "check_availability",
    description:
      "Check the calendar for existing events in a time range. Use this before booking to verify the slot is free. Returns a list of events (or empty if no conflicts).",
    input_schema: {
      type: "object" as const,
      properties: {
        date: {
          type: "string",
          description: "The date to check in YYYY-MM-DD format",
        },
        start_time: {
          type: "string",
          description:
            "Start of the window to check in HH:MM format (24h). If not specified, checks the whole day.",
        },
        end_time: {
          type: "string",
          description:
            "End of the window to check in HH:MM format (24h). If not specified, checks the whole day.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "book_appointment",
    description:
      "Book an appointment on the calendar. Creates a Google Calendar event with the given details. Always check_availability first to avoid double-booking.",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string",
          description: "Title/summary of the appointment (e.g. 'Consultation with John Smith')",
        },
        date: {
          type: "string",
          description: "Date of the appointment in YYYY-MM-DD format",
        },
        start_time: {
          type: "string",
          description: "Start time in HH:MM format (24h)",
        },
        end_time: {
          type: "string",
          description: "End time in HH:MM format (24h). Defaults to 1 hour after start if not provided.",
        },
        description: {
          type: "string",
          description: "Optional notes or description for the event",
        },
      },
      required: ["summary", "date", "start_time"],
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

type ToolInput = Record<string, string | undefined>;

/** Run a gog CLI command and return stdout. */
function runGog(args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gog", args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`gog ${args[0]} failed: ${stderr || err.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/** Get the local timezone offset string (e.g. "-04:00"). */
function getTzOffset(): string {
  const offset = new Date().getTimezoneOffset(); // minutes, positive = west of UTC
  const sign = offset <= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return `${sign}${h}:${m}`;
}

/** Build ISO datetime string with local timezone offset (required by Google Calendar). */
function toISO(date: string, time?: string): string {
  const tz = getTzOffset();
  if (!time) return `${date}T00:00:00${tz}`;
  return `${date}T${time}:00${tz}`;
}

/** Add N hours to a time string (HH:MM). Simple — no day rollover. */
function addHours(time: string, hours: number): string {
  const [h, m] = time.split(":").map(Number);
  const newH = Math.min((h ?? 0) + hours, 23);
  return `${String(newH).padStart(2, "0")}:${String(m ?? 0).padStart(2, "0")}`;
}

/** Validate that a date+time falls within business hours (Mon-Fri 9AM-5PM). */
function validateBusinessHours(date: string, startTime?: string): string | null {
  const d = new Date(`${date}T12:00:00`); // Noon to avoid timezone edge cases
  const day = d.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) {
    return `${date} is a weekend. Business hours are Monday through Friday, 9AM-5PM Eastern.`;
  }
  if (startTime) {
    const hour = parseInt(startTime.split(":")[0]!, 10);
    if (hour < 9 || hour >= 17) {
      return `${startTime} is outside business hours. Available times are 9:00 AM to 5:00 PM Eastern.`;
    }
  }
  return null; // Valid
}

export async function executeCalendarTool(
  toolName: string,
  input: ToolInput,
  calendarId: string,
): Promise<string> {
  try {
    if (toolName === "check_availability") {
      const date = input.date!;

      // Enforce business hours
      const bizError = validateBusinessHours(date, input.start_time);
      if (bizError) {
        return JSON.stringify({ available: false, error: bizError });
      }

      const from = toISO(date, input.start_time || "09:00");
      const to = toISO(date, input.end_time || "17:00");

      const result = await runGog([
        "calendar",
        "events",
        calendarId,
        "--from",
        from,
        "--to",
        to,
        "--json",
      ]);

      // Parse and simplify the response for the LLM
      try {
        const parsed = JSON.parse(result);
        const events = parsed.events ?? [];
        if (events.length === 0) {
          return JSON.stringify({ available: true, message: "No events found — time slot is free." });
        }
        // Return simplified event list
        const simplified = events.map((e: any) => ({
          summary: e.summary,
          start: e.start?.dateTime || e.start?.date,
          end: e.end?.dateTime || e.end?.date,
        }));
        return JSON.stringify({
          available: false,
          events: simplified,
          message: `Found ${events.length} event(s) in this time window.`,
        });
      } catch {
        return result; // Return raw if not JSON
      }
    }

    if (toolName === "book_appointment") {
      const summary = input.summary!;
      const date = input.date!;
      const startTime = input.start_time!;
      const endTime = input.end_time || addHours(startTime, 1);

      // Enforce business hours
      const bizError = validateBusinessHours(date, startTime);
      if (bizError) {
        return JSON.stringify({ success: false, error: bizError });
      }

      const from = toISO(date, startTime);
      const to = toISO(date, endTime);

      const args = [
        "calendar",
        "create",
        calendarId,
        "--summary",
        summary,
        "--from",
        from,
        "--to",
        to,
      ];

      if (input.description) {
        args.push("--description", input.description);
      }

      const result = await runGog(args);
      return JSON.stringify({ success: true, message: `Appointment booked: ${summary}`, raw: result });
    }

    return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  } catch (err) {
    return JSON.stringify({ error: String(err) });
  }
}

/**
 * Pre-warm the gog OAuth token by running a lightweight calendar list.
 * Call this on gateway startup so the first real tool call is fast.
 */
export function prewarmCalendarAuth(calendarId: string): void {
  const today = new Date().toISOString().split("T")[0];
  const tz = getTzOffset();
  runGog([
    "calendar", "events", calendarId,
    "--from", `${today}T00:00:00${tz}`,
    "--to", `${today}T00:01:00${tz}`,
  ]).then(() => {
    console.log("[voice-call] Calendar OAuth pre-warmed successfully");
  }).catch((err) => {
    console.warn(`[voice-call] Calendar OAuth pre-warm failed: ${err}`);
  });
}
