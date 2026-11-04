import fs from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { createTeamReportsHttpHandler } from "./http.js";
import { describePeriod } from "./periods.js";
import { renderMarkdown } from "./render/markdown.js";
import { measureReads, reportDocument, reportMember } from "./reports-data.test-support.js";
import { githubCounts } from "./reports.fixtures.js";
import { teamReportsSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createTeamReportsStore, type TeamReportsStore } from "./store.js";
import type { Period, Person, PersonReport, ReportDocument, SummaryDocument } from "./types.js";
import type { WorkSessions } from "./work-sessions.js";

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({ dispatchGatewayMethod: vi.fn() }));

const runtimeScopeMock = vi.hoisted(() => vi.fn());
const workerReads = vi.hoisted(() => ({ enabled: false, calls: 0, bytes: 0 }));
vi.mock("openclaw/plugin-sdk/database-engine-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/database-engine-runtime")>();
  return {
    ...actual,
    runEngineStoreOperation: async (...args: Parameters<typeof actual.runEngineStoreOperation>) => {
      const result = await actual.runEngineStoreOperation(...args);
      if (workerReads.enabled) {
        workerReads.calls += 1;
        workerReads.bytes += Buffer.byteLength(JSON.stringify(result) ?? "");
      }
      return result;
    },
  };
});
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: runtimeScopeMock,
}));

const maliciousTitle = '<script>alert("report")</script>';
const hostileLogin = 'bad"><img src=x onerror=alert(1)>';
const hostileDisplay = '"Quoted <Name>';
const counts = githubCounts(1);
const markdownSuffix = "\nStored Markdown only 雪 🦞\n".repeat(4096);
const avatarPeople: Person[] = [
  { github: ["invalid.login", "invalid-alias"], display: "Fallback Name" },
  { github: [hostileLogin, "hostile-alias"], display: hostileDisplay },
  { github: ["safe-login"], display: hostileDisplay },
  { github: ["a".repeat(40), "long-login-alias"], display: "Long Login" },
];

const member = (login: string, display = login, aliases: string[] = []): PersonReport =>
  reportMember(login, { display, aliases });

function report(period: Period, key: string, partial = false): ReportDocument {
  const descriptor = describePeriod(period, key);
  return reportDocument(
    [
      {
        ...member("alice", "Alice"),
        github: {
          ...counts,
          items: [
            {
              kind: "commit",
              repo: "example/project",
              title: maliciousTitle,
              url: "javascript:alert(1)",
              actor: "alice",
              atMs: descriptor.sinceMs,
            },
          ],
        },
      },
    ],
    {
      period: descriptor,
      status: partial ? "partial" : "closed",
      otherActors: [{ login: "bob", github: counts }],
      sources: { github: { ok: true, warnings: ["Fixture coverage warning"], stats: {} } },
    },
  );
}

const summary: SummaryDocument = {
  source: "fallback",
  generatedAtMs: 1,
  globalSummary: "Collected **one contribution**.",
  highlights: ["A recorded commit."],
  fingerprint: "fixture",
  warnings: ["Model summary unavailable: completion failed"],
};

const privateHeaders = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

type HttpResult = { status: number; headers: IncomingHttpHeaders; body: string };
let directory: string;
let store: TeamReportsStore;
let server: Server;
let port: number;
let available = true;
let currentOrgs = ["configured-example"];
const getStore = vi.fn(() => (available ? store : undefined));
const workSessions =
  vi.fn<(offset?: number, limit?: number, profileId?: string) => Promise<WorkSessions>>();

beforeEach(() => {
  runtimeScopeMock.mockReturnValue({ client: { connect: { scopes: ["operator.read"] } } });
  vi.mocked(dispatchGatewayMethod)
    .mockReset()
    .mockResolvedValue({
      ok: true,
      payload: {
        profiles: [
          { id: "alice-profile", mergedInto: null, githubIdentity: { login: "ALICE-ALIAS" } },
        ],
      },
    });
  getStore.mockClear();
  workSessions.mockReset().mockResolvedValue({ available: true, sessions: [] });
  currentOrgs = ["configured-example"];
});

function fetchPath(
  url: string,
  method = "GET",
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: url, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

async function page(url: string, method = "GET", headers: Record<string, string> = {}) {
  const response = await fetchPath(url, method, headers);
  expect(response).toMatchObject({
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  return response;
}

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "team-reports-http-"));
  store = await createTeamReportsStore({
    stateDir: directory,
    workerModuleUrl: resolveRuntimeWorkerUrl(teamReportsSqliteBackendEntrypoint),
  });
  const avatarReport = report("day", "2026-08-19");
  avatarReport.members = avatarPeople.map((person) =>
    member(person.github[0] ?? "", person.display ?? "", person.github.slice(1)),
  );
  avatarReport.memberCount = avatarPeople.length;
  avatarReport.activeMembers = avatarPeople.length;
  avatarReport.totals.github = githubCounts(avatarPeople.length);
  avatarReport.otherActors.push({ login: hostileLogin, github: counts });
  for (const document of [
    avatarReport,
    report("day", "2026-08-20"),
    report("day", "2026-08-21", true),
    report("week", "2026-W34"),
    report("month", "2026-08"),
  ]) {
    if (document.period.key === "2026-08-21") {
      document.members[0]!.github.items[0]!.body = "unrendered activity ".repeat(4096);
      document.members.push(member("report-only", "Report Only Person", ["report-only-alias"]));
      document.memberCount = 2;
      document.activeMembers = 2;
      document.totals.github = githubCounts(2);
    }
    await store.upsertPeriod({
      report: document,
      summary,
      markdown: renderMarkdown(document, summary) + markdownSuffix,
    });
  }
  const handler = createTeamReportsHttpHandler({
    basePath: "/reports",
    displayTimezone: "UTC",
    sessionRouting: () => ({ controlUiBasePath: "/control", mainKey: "home" }),
    workSessions,
    assetsDir: fileURLToPath(new URL("../assets", import.meta.url)),
    getStore,
    status: async () => ({ running: false, lastRun: "fixture-run" }),
    health: async () => ({ running: false, warnings: 1 }),
    orgs: () => currentOrgs,
    people: () => [
      {
        github: ["alice", "alice-alias"],
        display: "Alice",
        status: "archived",
        archivedAt: "2026-08-22",
      },
      ...avatarPeople,
    ],
  });
  server = createServer((req, res) => {
    void handler(req, res).catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  port = await listenOnLoopback(server);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("Team Reports HTTP responses", () => {
  it.each([
    { context: "missing", scopes: undefined },
    { context: "approvals only", scopes: ["operator.approvals"] },
  ])(
    "denies GET and HEAD without read authority ($context) before store access",
    async ({ scopes }) => {
      runtimeScopeMock.mockReturnValue(scopes ? { client: { connect: { scopes } } } : undefined);
      for (const url of [
        "/reports/",
        "/reports/assets/crab.avif",
        "/reports/assets/icon.png",
        "/reports/status",
        "/reports/sessions/",
        "/reports/index.json",
        "/reports/latest/",
        "/reports/people/",
        "/reports/people/alice/",
        "/reports/day/2026-08-20/",
        "/reports/day/2026-08-20/report.md",
        "/reports/day/2026-08-20/data.json",
      ]) {
        for (const method of ["GET", "HEAD"]) {
          const response = await fetchPath(url, method);
          expect(response).toMatchObject({
            status: 403,
            body: method === "HEAD" ? "" : "Forbidden: operator.read scope required.\n",
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
          expect(Number(response.headers["content-length"])).toBe(
            Buffer.byteLength("Forbidden: operator.read scope required.\n"),
          );
          expect(response.headers).toMatchObject(privateHeaders);
          expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
          expect(response.headers["content-security-policy"]).toMatch(/style-src 'nonce-[^']+'/);
        }
      }
      expect(getStore).not.toHaveBeenCalled();
      expect(workSessions).not.toHaveBeenCalled();
    },
  );

  it.each(["operator.write", "operator.admin"])(
    "allows GET and HEAD with %s authority",
    async (scope) => {
      runtimeScopeMock.mockReturnValue({ client: { connect: { scopes: [scope] } } });
      for (const method of ["GET", "HEAD"]) {
        const response = await page("/reports/day/2026-08-20/", method);
        if (method === "HEAD") {
          expect(response.body).toBe("");
          expect(Number(response.headers["content-length"])).toBeGreaterThan(0);
        } else {
          expect(response.body).toContain("Alice");
        }
      }
    },
  );

  it("serves escaped HTML with one nonce-authorized script and safe navigation", async () => {
    const response = await page("/reports/day/2026-08-20/", "GET", {
      "x-forwarded-proto": "https",
    });
    expect(response.headers).toMatchObject(privateHeaders);
    expect(response.headers["x-frame-options"]).toBeUndefined();
    const csp = response.headers["content-security-policy"];
    const nonce = typeof csp === "string" ? /style-src 'nonce-([^']+)'/.exec(csp)?.[1] : undefined;
    expect(nonce).toBeTruthy();
    expect(csp).toBe(
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self' https://avatars.githubusercontent.com data:; base-uri 'none'; form-action 'none'`,
    );
    expect(response.body.match(/<script\b/g)).toHaveLength(1);
    expect(response.body).not.toContain('href="javascript:');
    expect(response.body).toContain(`<style nonce="${nonce}">`);
    expect(response.body).toContain(`<script nonce="${nonce}">`);
    expect(response.body).toContain("&lt;script&gt;alert(&quot;report&quot;)&lt;/script&gt;");
    expect(response.body).toContain(
      `href="https://127.0.0.1:${port}/reports/day/2026-08-20/" target="_blank" rel="noopener" data-report-open-window aria-label="Open in a new window"`,
    );
    expect(response.body).toContain('href="/reports/people/alice/"');
    expect(response.body).toContain("Summary without a model");
    expect(response.body).toContain("Fixture coverage warning");
    expect(response.body).toContain("Model summary unavailable: completion failed");
    expect(response.body).toContain("GitHub coverage is incomplete");
  });

  it("keeps unsafe avatar identities escaped and falls back to initials", async () => {
    const response = await page("/reports/day/2026-08-19/");
    const avatars = response.body.match(/<span class="oc-avatar\b[^>]*>[\s\S]*?<\/span>/g) ?? [];
    for (const value of ["FN", "LL", "&quot;&lt;"]) {
      const fallback = avatars.find(
        (avatar) => avatar.includes(`data-initials="${value}"`) && !avatar.includes("<img"),
      );
      expect(fallback).toBeDefined();
    }
    expect(response.body).not.toContain("avatars.githubusercontent.com/invalid.login");
    expect(response.body).not.toContain(`avatars.githubusercontent.com/${"a".repeat(40)}`);
    expect(response.body).not.toContain("avatars.githubusercontent.com/bad");
    expect(response.body).not.toContain(hostileLogin);
    expect(response.body).not.toContain(hostileDisplay);
    expect(response.body).not.toContain("<img src=x");
    expect(response.body).toContain("bad&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(response.body).toContain("&quot;Quoted &lt;Name&gt;");
    expect(response.body).toContain('data-initials="&quot;&lt;"');
    expect(response.body).toContain('src="https://avatars.githubusercontent.com/safe-login?s=40"');
  });

  it.each([
    ["crab.avif", "image/avif"],
    ["icon.png", "image/png"],
  ])("serves authenticated %s bytes with private caching and HEAD", async (asset, contentType) => {
    const get = await fetchPath(`/reports/assets/${asset}`);
    const head = await fetchPath(`/reports/assets/${asset}`, "HEAD");
    for (const response of [get, head]) {
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe(contentType);
      expect(response.headers["cache-control"]).toBe("private, max-age=86400");
      expect(Number(response.headers["content-length"])).toBe(
        fs.statSync(new URL(`../assets/${asset}`, import.meta.url)).size,
      );
    }
    expect(get.body.length).toBeGreaterThan(0);
    expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
  });

  it("rejects writes", async () => {
    const post = await fetchPath("/reports/day/2026-08-20/", "POST");
    expect(post).toMatchObject({ status: 405, headers: { allow: "GET, HEAD" } });
  });

  it.each([
    "/reports/assets/unknown.png",
    "/reports/missing/",
    "/reports/day/2026-02-30/",
    "/reports/week/2026-W54/",
    "/reports/day/2026-08-20/unknown",
    "/reports/day/../2026-08-20/",
    "/reports/people/alice%2fextra/",
    "/reports-elsewhere/",
  ])("returns 404 for unknown or unsafe path %s", async (url) => {
    const response = await fetchPath(url);
    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
  });

  it("redirects latest to a closed day even when a newer partial exists", async () => {
    const response = await fetchPath("/reports/latest/");
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/reports/day/2026-08-20/");
  });

  it("serves week Markdown and canonical JSON", async () => {
    const period = "week";
    const key = "2026-W34";
    const markdown = await fetchPath(`/reports/${period}/${key}/report.md`);
    expect(markdown.status).toBe(200);
    expect(markdown.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(markdown.body).toContain(key);
    expect(markdown.body).not.toContain(maliciousTitle);
    expect(markdown.body).toContain("> Model summary unavailable: completion failed\n");
    expect(markdown.body).toBe(renderMarkdown(report(period, key), summary) + markdownSuffix);
    const json = await fetchPath(`/reports/${period}/${key}/data.json`);
    expect(json.status).toBe(200);
    expect(json.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(json.body)).toMatchObject({ version: 1, period: { period, key } });
  });

  it.each(["/reports/", "/reports/day/2026-08-20/", "/reports/day/2026-08-20/data.json"])(
    "serves %s without transferring unused Markdown from storage",
    async (url) => {
      await measureReads(workerReads, async () => {
        const response = await fetchPath(url);
        expect(response.status).toBe(200);
        expect(response.body).toContain("example");
        expect(response.body).not.toContain("Stored Markdown only");
      });
      expect(workerReads.bytes).toBeGreaterThan(0);
      expect(workerReads.bytes).toBeLessThan(Buffer.byteLength(markdownSuffix));
    },
  );

  it("renders stored trends, history, archived people, index, and status", async () => {
    const index = await page("/reports/");
    expect(index.body).toContain('aria-label="Activity dateline"');
    expect(index.body).toContain('href="/reports/week/2026-W34/"');
    await measureReads(workerReads, async () => {
      const people = await page("/reports/people/");
      expect(people.body).toContain("Member Activity Timelines");
      expect(people.body).toMatch(/class="oc-badge oc-badge-neutral">Archived<\/span>/);
      expect(people.body).toContain("Report Only Person");
      expect(people.body).toContain('href="/reports/people/report-only/"');
      const person = await page("/reports/people/alice-alias/");
      expect(person.body).toContain('src="https://avatars.githubusercontent.com/alice?s=72"');
      expect(person.body).toContain("Archived on 2026-08-22");
      expect(person.body).toContain('href="/reports/day/2026-08-20/?person=alice"');
    });
    expect(workerReads.bytes).toBeGreaterThan(0);
    expect.soft(workerReads.calls).toBeLessThanOrEqual(4);
    expect.soft(workerReads.bytes).toBeLessThan(16 * 1024);
    const machineIndex = await fetchPath("/reports/index.json");
    expect(JSON.parse(machineIndex.body)).toMatchObject({
      latest: { day: "2026-08-21", week: "2026-W34", month: "2026-08" },
    });
    const status = await fetchPath("/reports/status");
    expect(JSON.parse(status.body)).toEqual({ running: false, lastRun: "fixture-run" });
  });

  it("reads current overview organizations and prefers the displayed report's organizations", async () => {
    const emptyStore = await createTeamReportsStore({
      stateDir: path.join(directory, "empty"),
      workerModuleUrl: resolveRuntimeWorkerUrl(teamReportsSqliteBackendEntrypoint),
    });
    try {
      for (const name of ["first-organization", "new <organization>"]) {
        currentOrgs = [name];
        getStore.mockReturnValueOnce(emptyStore);
        const response = await page("/reports/");
        expect(response.body).toContain(
          name.replaceAll("<", "&lt;").replaceAll(">", "&gt;") + " · team",
        );
      }
      const stored = await fetchPath("/reports/");
      expect(stored.body).toContain("example · team");
      expect(stored.body).not.toContain("new &lt;organization&gt; · team");
    } finally {
      await emptyStore.close();
    }
  });

  it("renders current session links, owners and pagination without changing report exports", async () => {
    workSessions.mockResolvedValue({
      available: true,
      sessions: [
        {
          key: "agent:writer:dashboard:demo",
          agentId: "writer",
          displayName: "Fix <navigation>",
          owner: { actor: { type: "human", label: "Alice & Bob" } },
          status: "running",
        },
      ],
      nextOffset: 80,
    });
    const sessions = await page("/reports/sessions/?offset=40");
    expect(workSessions).toHaveBeenLastCalledWith(40, 40);
    expect(sessions.body).toContain('href="/control/chat/writer/dashboard/demo"');
    expect(sessions.body).toContain("Fix &lt;navigation&gt;");
    expect(sessions.body).toContain("Alice &amp; Bob");
    expect(sessions.body).toContain('data-work-session-key="agent:writer:dashboard:demo"');
    expect(sessions.body).toContain('href="/reports/sessions/?offset=80"');
    expect(sessions.body).toContain('href="/reports/sessions/?offset=0"');
    const home = await fetchPath("/reports/");
    expect(home.body).toContain("Fix &lt;navigation&gt;");
    expect(workSessions).toHaveBeenLastCalledWith(0, 8);
    workSessions.mockClear();
    await fetchPath("/reports/day/2026-08-20/data.json");
    await fetchPath("/reports/day/2026-08-20/report.md");
    expect(workSessions).not.toHaveBeenCalled();
  });

  it("rejects an unsafe integer session offset", async () => {
    expect((await fetchPath("/reports/sessions/?offset=9007199254740992")).status).toBe(400);
    expect(workSessions).not.toHaveBeenCalled();
  });

  it("distinguishes unavailable session discovery from an empty visible list", async () => {
    expect((await fetchPath("/reports/sessions/")).body).toContain(
      "No work sessions are visible to you",
    );
    workSessions.mockResolvedValue({ available: false });
    const overview = await page("/reports/");
    expect(overview.body).toContain("Work sessions unavailable");
    expect(overview.body).toContain("Day History");
    expect(overview.body).not.toContain("No work sessions are visible to you");
  });

  it("reports unavailable service state without touching a closed store", async () => {
    available = false;
    try {
      const response = await fetchPath("/reports/");
      expect(response.status).toBe(503);
      expect(response.body).toContain("Check plugin configuration and reload the plugin");
    } finally {
      available = true;
    }
  });
});

describe("per-member session links through HTTP", () => {
  it("links current owned sessions inside a monthly report", async () => {
    workSessions.mockResolvedValue({
      available: true,
      sessions: [{ key: "agent:writer:dashboard:alice-work", label: "Current Alice work" }],
      nextOffset: 3,
    });
    const response = await page("/reports/month/2026-08/");
    expect(response.body).toContain("Current work / owned sessions");
    expect(response.body).toContain('href="/control/chat/writer/dashboard/alice-work"');
    expect(response.body).toContain('data-work-session-key="agent:writer:dashboard:alice-work"');
    expect(response.body).toContain("not activity from this report period");
    expect(response.body).toContain("?person=alice");
    expect(workSessions).toHaveBeenCalledExactlyOnceWith(0, 3, "alice-profile");
    expect(dispatchGatewayMethod).toHaveBeenCalledExactlyOnceWith("users.list", {});
  });

  it("keeps person selection in directory pagination and resolves configured aliases", async () => {
    workSessions.mockResolvedValue({ available: true, sessions: [], nextOffset: 80 });
    const response = await fetchPath("/reports/sessions/?person=ALICE-ALIAS&offset=40");
    expect(response.body).toContain("owned sessions for @alice");
    expect(response.body).toContain("person=alice&offset=80");
    expect(response.body).toContain("person=alice&offset=0");
    expect(workSessions).toHaveBeenCalledExactlyOnceWith(40, 40, "alice-profile");
  });

  it.each([
    { profiles: [], message: "No linked GitHub profile" },
    {
      profiles: [
        { id: "one", mergedInto: null, githubIdentity: { login: "alice" } },
        { id: "two", mergedInto: null, githubIdentity: { login: "alice-alias" } },
      ],
      message: "Multiple or unresolved linked profiles",
    },
  ])("shows $message without global-session fallback", async ({ profiles, message }) => {
    vi.mocked(dispatchGatewayMethod).mockResolvedValue({ ok: true, payload: { profiles } });
    const response = await fetchPath("/reports/people/alice/");
    expect(response.body).toContain(message);
    expect(workSessions).not.toHaveBeenCalled();
  });
});
