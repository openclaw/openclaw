import { describe, expect, it, vi } from "vitest";
import type { M365GraphClient, M365GraphRequest } from "./graph.js";
import { createM365CalendarTool } from "./tool.js";

function createGraphClient(response: unknown) {
  const requests: M365GraphRequest[] = [];
  const client: M365GraphClient = {
    requestJson: vi.fn(async (path, options) => {
      requests.push({
        method: (options?.method as M365GraphRequest["method"] | undefined) ?? "GET",
        path,
        ...(options?.query ? { query: options.query as M365GraphRequest["query"] } : {}),
        ...(options?.body !== undefined ? { body: options.body } : {}),
      });
      return response;
    }),
  };
  return { client, requests };
}

describe("M365 calendar tool", () => {
  it("returns agenda details through the injected Graph client", async () => {
    const { client, requests } = createGraphClient({ value: [] });
    const tool = createM365CalendarTool({ graphClient: client });

    const result = await tool.execute({
      action: "agenda",
      calendarUser: "owner@example.com",
      start: "2026-04-14T00:00:00",
      end: "2026-04-15T00:00:00",
    });

    expect(requests).toHaveLength(1);
    expect(result.details).toMatchObject({
      ok: true,
      action: "agenda",
      calendarUser: "owner@example.com",
      events: [],
    });
  });

  it("queues calendar changes without requiring a Graph client", async () => {
    const tool = createM365CalendarTool({
      defaultCalendarUser: "owner@example.com",
      defaultTimeZone: "UTC",
    });

    const result = await tool.execute({
      action: "queue_change",
      operation: "create",
      subject: "Planning",
      start: "2026-04-14T10:00:00",
      end: "2026-04-14T10:30:00",
      attendees: ["Alice@Example.com"],
    });

    const queuedChange = result.details.queuedChange as Record<string, unknown>;
    const approvalSnapshot = queuedChange.approvalSnapshot as Record<string, unknown>;
    expect(queuedChange.kind).toBe("m365.calendar.queued_change");
    expect(typeof queuedChange.planHash).toBe("string");
    expect(approvalSnapshot).toMatchObject({
      kind: "m365.calendar.approval",
      title: "Send calendar invite?",
      severity: "warning",
    });
  });

  it("rejects create queue changes without a complete time range", async () => {
    const tool = createM365CalendarTool({ defaultCalendarUser: "owner@example.com" });

    await expect(
      tool.execute({
        action: "queue_change",
        operation: "create",
        start: "2026-04-14T10:00:00",
      }),
    ).rejects.toThrow("start and end required for create calendar changes");
  });

  it("requires a Graph client for agenda and free-busy actions", async () => {
    const tool = createM365CalendarTool({ defaultCalendarUser: "owner@example.com" });

    await expect(
      tool.execute({
        action: "free_busy",
        start: "2026-04-14T10:00:00",
        end: "2026-04-14T11:00:00",
      }),
    ).rejects.toThrow("free_busy requires an M365 Graph client");
  });
});
