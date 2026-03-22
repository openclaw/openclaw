// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CronDashboard } from "./cron-dashboard";

function ms(value: string): number {
  return new Date(value).getTime();
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

const jobsResponse = {
  jobs: [
    {
      id: "workspace-sync",
      name: "Workspace GitHub Sync",
      enabled: true,
      createdAtMs: ms("2026-03-01T09:00:00-08:00"),
      updatedAtMs: ms("2026-03-21T08:01:00-07:00"),
      schedule: { kind: "cron", expr: "0 8,18 * * *", tz: "America/Los_Angeles" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "sync" },
      state: {
        nextRunAtMs: ms("2026-03-21T18:00:00-07:00"),
        lastRunAtMs: ms("2026-03-21T08:00:20-07:00"),
        lastStatus: "ok",
        lastDurationMs: 20_000,
      },
    },
    {
      id: "crm-morning",
      name: "Personal CRM sync (morning)",
      enabled: true,
      createdAtMs: ms("2026-03-01T09:00:00-08:00"),
      updatedAtMs: ms("2026-03-21T08:01:00-07:00"),
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "America/Los_Angeles" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "sync" },
      state: {
        nextRunAtMs: ms("2026-03-22T08:00:00-07:00"),
        lastRunAtMs: ms("2026-03-21T08:00:15-07:00"),
        lastStatus: "ok",
        lastDurationMs: 15_000,
      },
    },
    {
      id: "crm-evening",
      name: "Personal CRM sync (evening)",
      enabled: true,
      createdAtMs: ms("2026-03-01T09:00:00-08:00"),
      updatedAtMs: ms("2026-03-20T18:01:00-07:00"),
      schedule: { kind: "cron", expr: "0 18 * * *", tz: "America/Los_Angeles" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "sync" },
      state: {
        nextRunAtMs: ms("2026-03-21T18:00:00-07:00"),
        lastRunAtMs: ms("2026-03-20T18:00:10-07:00"),
        lastStatus: "ok",
        lastDurationMs: 10_000,
      },
    },
  ],
  heartbeat: { intervalMs: 30 * 60_000, nextDueEstimateMs: null },
  cronStatus: { enabled: true, nextWakeAtMs: ms("2026-03-21T18:00:00-07:00") },
};

const runsByJobId: Record<string, Array<Record<string, unknown>>> = {
  "workspace-sync": [
    {
      ts: ms("2026-03-20T08:00:25-07:00"),
      runAtMs: ms("2026-03-20T08:00:00-07:00"),
      jobId: "workspace-sync",
      action: "finished",
      status: "ok",
      durationMs: 25_000,
    },
    {
      ts: ms("2026-03-20T18:00:22-07:00"),
      runAtMs: ms("2026-03-20T18:00:00-07:00"),
      jobId: "workspace-sync",
      action: "finished",
      status: "ok",
      durationMs: 22_000,
    },
    {
      ts: ms("2026-03-21T08:00:20-07:00"),
      runAtMs: ms("2026-03-21T08:00:00-07:00"),
      jobId: "workspace-sync",
      action: "finished",
      status: "ok",
      durationMs: 20_000,
    },
  ],
  "crm-morning": [
    {
      ts: ms("2026-03-20T08:00:18-07:00"),
      runAtMs: ms("2026-03-20T08:00:00-07:00"),
      jobId: "crm-morning",
      action: "finished",
      status: "ok",
      durationMs: 18_000,
    },
    {
      ts: ms("2026-03-21T08:00:15-07:00"),
      runAtMs: ms("2026-03-21T08:00:00-07:00"),
      jobId: "crm-morning",
      action: "finished",
      status: "ok",
      durationMs: 15_000,
    },
  ],
  "crm-evening": [
    {
      ts: ms("2026-03-20T18:00:10-07:00"),
      runAtMs: ms("2026-03-20T18:00:00-07:00"),
      jobId: "crm-evening",
      action: "finished",
      status: "ok",
      durationMs: 10_000,
    },
  ],
};

describe("CronDashboard calendar", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-21T17:00:00-07:00"));

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/cron/jobs") {
        return Promise.resolve(jsonResponse(jobsResponse));
      }
      const jobMatch = url.match(/^\/api\/cron\/jobs\/([^/]+)\/runs\?limit=50$/);
      if (jobMatch) {
        const jobId = decodeURIComponent(jobMatch[1] ?? "");
        return Promise.resolve(jsonResponse({ entries: runsByJobId[jobId] ?? [] }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });

    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows each Mar 21 occurrence once in day view with morning runs and evening schedules in the right slots", async () => {
    render(
      <CronDashboard
        onSelectJob={vi.fn()}
        activeView="calendar"
        calendarMode="day"
        calendarDate="2026-03-21"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Saturday, March 21, 2026/i)).toBeInTheDocument();
    });

    expect(screen.getAllByRole("button", { name: "08:00 AM Workspace GitHub Sync" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "08:00 AM Personal CRM sync (morning)" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "06:00 PM Workspace GitHub Sync" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "06:00 PM Personal CRM sync (evening)" })).toHaveLength(1);
  });

  it("only keeps future scheduled chips in week view so historical days are not doubled", async () => {
    render(
      <CronDashboard
        onSelectJob={vi.fn()}
        activeView="calendar"
        calendarMode="week"
        calendarDate="2026-03-21"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/March 15.*21, 2026/i)).toBeInTheDocument();
    });

    expect(screen.getAllByTitle(/Scheduled:/)).toHaveLength(2);
    expect(screen.queryByTitle("Scheduled: Personal CRM sync (morning) at 08:00 AM")).not.toBeInTheDocument();
    expect(screen.getAllByTitle("ok: Workspace GitHub Sync at 08:00 AM").length).toBeGreaterThan(0);
  });
});
