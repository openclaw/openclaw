import { once } from "node:events";
import fs from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTeamReportsHttpHandler } from "./http.js";
import { describePeriod } from "./periods.js";
import { renderMarkdown } from "./render/markdown.js";
import { githubCounts } from "./reports.fixtures.js";
import { teamReportsSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createTeamReportsStore, type TeamReportsStore } from "./store.js";
import type { Period, Person, ReportDocument, SummaryDocument } from "./types.js";
import type { WorkSessions } from "./work-sessions.js";

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({ dispatchGatewayMethod: vi.fn() }));

const runtimeScopeMock = vi.hoisted(() => vi.fn());
const workerReads = vi.hoisted(() => ({ enabled: false, calls: 0, bytes: 0 }));
vi.mock("openclaw/plugin-sdk/sqlite-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sqlite-runtime")>();
  return {
    ...actual,
    openSqliteWorkerStore: async (...args: Parameters<typeof actual.openSqliteWorkerStore>) => {
      const worker = await actual.openSqliteWorkerStore(...args);
      if (worker) {
        const execute = worker.execute.bind(worker);
        vi.spyOn(worker, "execute").mockImplementation(async (command, options) => {
          const result = await execute(command, options);
          if (workerReads.enabled) {
            workerReads.calls += 1;
            workerReads.bytes += Buffer.byteLength(JSON.stringify(result) ?? "");
          }
          return result;
        });
      }
      return worker;
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

function report(period: Period, key: string, partial = false): ReportDocument {
  const descriptor = describePeriod(period, key);
  return {
    version: 1,
    period: descriptor,
    generatedAtMs: descriptor.untilMs,
    status: partial ? "partial" : "closed",
    orgs: ["example"],
    memberCount: 1,
    activeMembers: 1,
    totals: { github: counts, discord: { messages: 0, channels: {} } },
    members: [
      {
        login: "alice",
        display: "Alice",
        aliases: [],
        access: [],
        areas: [],
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
        discord: { total: 0, channels: {}, excerpts: [] },
      },
    ],
    otherActors: [{ login: "bob", github: counts }],
    unmatchedDiscord: [],
    sources: { github: { ok: true, warnings: ["Fixture coverage warning"], stats: {} } },
  };
}

const summary: SummaryDocument = {
  source: "fallback",
  generatedAtMs: 1,
  globalSummary: "Collected **one contribution**.",
  highlights: ["A recorded commit."],
  fingerprint: "fixture",
  warnings: ["Model summary unavailable: completion failed"],
};

type HttpResult = { status: number; headers: IncomingHttpHeaders; body: string };
let directory: string;
let store: TeamReportsStore;
let server: Server;
let port: number;
let available = true;
let currentOrgs = ["configured-example"];
let currentMainKey = "home";
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
  currentMainKey = "home";
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

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "team-reports-http-"));
  store = await createTeamReportsStore({
    stateDir: directory,
    workerModuleUrl: resolveRuntimeWorkerUrl(teamReportsSqliteBackendEntrypoint),
  });
  const avatarReport = report("day", "2026-08-19");
  avatarReport.members = avatarPeople.map((person) => ({
    login: person.github[0] ?? "",
    display: person.display ?? "",
    aliases: person.github.slice(1),
    access: [],
    areas: [],
    github: { ...counts, items: [] },
    discord: { total: 0, channels: {}, excerpts: [] },
  }));
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
      document.members.push({
        login: "report-only",
        display: "Report Only Person",
        aliases: ["report-only-alias"],
        access: [],
        areas: [],
        github: { ...counts, items: [] },
        discord: { total: 0, channels: {}, excerpts: [] },
      });
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
    sessionRouting: () => ({ controlUiBasePath: "/control", mainKey: currentMainKey }),
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
        discordUserId: "1234567890",
      },
      ...avatarPeople,
    ],
  });
  server = createServer((req, res) => {
    void handler(req, res).catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }
  port = address.port;
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
    { context: "empty", scopes: [] },
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
          expect(response.status).toBe(403);
          expect(response.body).toBe(
            method === "HEAD" ? "" : "Forbidden: operator.read scope required.\n",
          );
          expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
          expect(Number(response.headers["content-length"])).toBe(
            Buffer.byteLength("Forbidden: operator.read scope required.\n"),
          );
          expect(response.headers["cache-control"]).toBe("private, no-store");
          expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
          expect(response.headers["content-security-policy"]).toMatch(/style-src 'nonce-[^']+'/);
          expect(response.headers["x-content-type-options"]).toBe("nosniff");
          expect(response.headers["referrer-policy"]).toBe("no-referrer");
        }
      }
      expect(getStore).not.toHaveBeenCalled();
      expect(workSessions).not.toHaveBeenCalled();
    },
  );

  it.each(["operator.read", "operator.write", "operator.admin"])(
    "allows GET and HEAD with %s authority",
    async (scope) => {
      runtimeScopeMock.mockReturnValue({ client: { connect: { scopes: [scope] } } });
      for (const method of ["GET", "HEAD"]) {
        const response = await fetchPath("/reports/day/2026-08-20/", method);
        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
        if (method === "HEAD") {
          expect(response.body).toBe("");
        } else {
          expect(response.body).toContain("Alice");
        }
      }
    },
  );

  it("serves escaped HTML with one nonce-authorized script and safe navigation", async () => {
    const response = await fetchPath("/reports/day/2026-08-20/", "GET", {
      "x-forwarded-proto": "https",
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-frame-options"]).toBeUndefined();
    const csp = response.headers["content-security-policy"];
    const nonce = typeof csp === "string" ? /style-src 'nonce-([^']+)'/.exec(csp)?.[1] : undefined;
    expect(nonce).toBeTruthy();
    expect(csp).toBe(
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self' https://avatars.githubusercontent.com data:; base-uri 'none'; form-action 'none'`,
    );
    expect(response.body).toContain(`<style nonce="${nonce}">`);
    expect(response.body).toContain("&lt;script&gt;alert(&quot;report&quot;)&lt;/script&gt;");
    expect(response.body.match(/<script\b/g)).toHaveLength(1);
    expect(response.body).toContain(`<script nonce="${nonce}">`);
    expect(response.body).not.toContain('href="javascript:');
    expect(response.body).toContain(
      `href="https://127.0.0.1:${port}/reports/day/2026-08-20/" target="_blank" rel="noopener" data-report-open-window aria-label="Open in a new window"`,
    );
    expect(response.body).toContain('href="/reports/people/alice/"');
    expect(response.body).toContain("Deterministic summary");
    expect(response.body).toContain("Fixture coverage warning");
    expect(response.body).toContain("Model summary unavailable: completion failed");
    expect(response.body).toContain("GitHub coverage is incomplete");
  });

  it.each([
    { url: "/reports/day/2026-08-20/", login: "alice", size: 40, variant: "md" },
    { url: "/reports/people/alice-alias/", login: "alice", size: 72, variant: "xl" },
  ])(
    "renders a $size px GitHub avatar for $login on $url",
    async ({ url, login, size, variant }) => {
      const response = await fetchPath(url);
      expect(response.status).toBe(200);
      const avatars = response.body.match(/<span class="oc-avatar\b[^>]*>[\s\S]*?<\/span>/g) ?? [];
      const avatar = avatars.find((markup) =>
        markup.includes(`src="https://avatars.githubusercontent.com/${login}?s=${size}"`),
      );
      expect(avatar).toContain(`class="oc-avatar oc-avatar-${variant}"`);
      expect(avatar).toMatch(/data-initials="[^"]+"/);
      for (const attribute of [
        `width="${size}"`,
        `height="${size}"`,
        'alt=""',
        'loading="lazy"',
        'decoding="async"',
        'referrerpolicy="no-referrer"',
      ]) {
        expect(avatar).toContain(attribute);
      }
      expect(response.body).not.toContain("avatars.githubusercontent.com/alice-alias");
      expect(response.body).not.toContain("avatars.githubusercontent.com/Alice");
      expect(response.body).not.toContain("avatars.githubusercontent.com/1234567890");
    },
  );

  it("keeps unsafe avatar identities escaped and falls back to initials", async () => {
    const response = await fetchPath("/reports/day/2026-08-19/");
    expect(response.status).toBe(200);
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
  });

  it("uses the GitHub login for an avatar even when the display name is hostile", async () => {
    const response = await fetchPath("/reports/people/safe-login/");
    expect(response.status).toBe(200);
    expect(response.body).toContain('src="https://avatars.githubusercontent.com/safe-login?s=72"');
    expect(response.body).toContain('data-initials="&quot;&lt;"');
    expect(response.body).toContain("&quot;Quoted &lt;Name&gt;");
    expect(response.body).not.toContain(hostileDisplay);
  });

  it("serves dark and light semantic tokens with CSS-only avatar initials", async () => {
    const response = await fetchPath("/reports/");
    const styles = /<style nonce="[^"]+">([\s\S]*?)<\/style>/.exec(response.body)?.[1];
    expect(styles).toMatch(/color-scheme:\s*dark/);
    expect(styles).toMatch(/html\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light/);
    expect(styles).toMatch(
      /@media\s*\(prefers-color-scheme:\s*light\)\s*\{[^}]*color-scheme:\s*light/,
    );
    for (const token of [
      "bg-page",
      "text-primary",
      "accent-primary",
      "accent-secondary",
      "status-warning-fg",
    ]) {
      expect(styles?.match(new RegExp(`--oc-${token}:`, "g"))?.length).toBeGreaterThanOrEqual(3);
    }
    expect(styles).toMatch(/\.oc-avatar::before\s*\{[^}]*content:\s*attr\(data-initials\)/);
    expect(styles).not.toMatch(/@import|@font-face/);
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

  it("supports HEAD without a body and rejects writes", async () => {
    const head = await fetchPath("/reports/day/2026-08-20/", "HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(Number(head.headers["content-length"])).toBeGreaterThan(0);
    expect(head.headers["content-type"]).toBe("text/html; charset=utf-8");
    const post = await fetchPath("/reports/day/2026-08-20/", "POST");
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
  });

  it.each([
    "/reports/assets/unknown.png",
    "/reports/assets/crab.avif/extra",
    "/reports/missing/",
    "/reports/day/2026-02-30/",
    "/reports/week/2026-W54/",
    "/reports/day/2026-08-20/unknown",
    "/reports/day/../2026-08-20/",
    "/reports/day/%2e%2e/2026-08-20/",
    "/reports/people/alice%2fextra/",
    "/reports/people/alice\\extra/",
    "/reports//",
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

  it.each([
    ["day", "2026-08-20"],
    ["week", "2026-W34"],
    ["month", "2026-08"],
  ] as const)("serves %s Markdown and canonical JSON", async (period, key) => {
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
      workerReads.calls = 0;
      workerReads.bytes = 0;
      workerReads.enabled = true;
      try {
        const response = await fetchPath(url);
        expect(response.status).toBe(200);
        expect(response.body).toContain("example");
        expect(response.body).not.toContain("Stored Markdown only");
      } finally {
        workerReads.enabled = false;
      }
      expect(workerReads.calls).toBeGreaterThan(0);
      expect(workerReads.bytes).toBeGreaterThan(0);
      expect(workerReads.bytes).toBeLessThan(Buffer.byteLength(markdownSuffix));
    },
  );

  it("renders stored trends, history, archived people, index, and status", async () => {
    const index = await fetchPath("/reports/");
    expect(index.status).toBe(200);
    expect(index.body).toContain('aria-label="Activity dateline"');
    expect(index.body).toContain('href="/reports/week/2026-W34/"');
    workerReads.calls = 0;
    workerReads.bytes = 0;
    workerReads.enabled = true;
    try {
      const people = await fetchPath("/reports/people/");
      expect(people.status).toBe(200);
      expect(people.body).toContain("Member Activity Timelines");
      expect(people.body).toMatch(/class="oc-badge oc-badge-neutral">Archived<\/span>/);
      expect(people.body).toContain("Report Only Person");
      expect(people.body).toContain('href="/reports/people/report-only/"');
      const person = await fetchPath("/reports/people/alice-alias/");
      expect(person.status).toBe(200);
      expect(person.body).toContain("Archived on 2026-08-22");
      expect(person.body).toContain('href="/reports/day/2026-08-20/?person=alice"');
    } finally {
      workerReads.enabled = false;
    }
    expect(workerReads.calls).toBeGreaterThan(0);
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
        const response = await fetchPath("/reports/");
        expect(response.status).toBe(200);
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
    const page = await fetchPath("/reports/sessions/?offset=40");
    expect(page.status).toBe(200);
    expect(workSessions).toHaveBeenLastCalledWith(40, 40);
    expect(page.body).toContain('href="/control/chat/writer/dashboard/demo"');
    expect(page.body).toContain("Fix &lt;navigation&gt;");
    expect(page.body).toContain("Alice &amp; Bob");
    expect(page.body).toContain('data-work-session-key="agent:writer:dashboard:demo"');
    expect(page.body).toContain('href="/reports/sessions/?offset=80"');
    expect(page.body).toContain('href="/reports/sessions/?offset=0"');
    const home = await fetchPath("/reports/");
    expect(home.body).toContain("Fix &lt;navigation&gt;");
    expect(workSessions).toHaveBeenLastCalledWith(0, 8);
    workSessions.mockClear();
    await fetchPath("/reports/day/2026-08-20/data.json");
    await fetchPath("/reports/day/2026-08-20/report.md");
    expect(workSessions).not.toHaveBeenCalled();
  });

  it("keeps a named main session distinct from the configured home session", async () => {
    workSessions.mockResolvedValue({
      available: true,
      sessions: [
        { key: "agent:writer:main", displayName: "Named main" },
        { key: "agent:writer:home", displayName: "Home session" },
      ],
    });
    const page = await fetchPath("/reports/sessions/");
    expect(page.body).toContain('href="/control/chat/writer/~key/main"');
    expect(page.body).toContain('href="/control/chat/writer"');
    currentMainKey = "main";
    const reloaded = await fetchPath("/reports/sessions/");
    expect(reloaded.body).toContain('href="/control/chat/writer/home"');
    expect(reloaded.body).not.toContain('href="/control/chat/writer/~key/main"');
  });

  it.each(["-1", "1.5", "NaN", "9007199254740992"])(
    "rejects invalid session offset %s",
    async (offset) => {
      expect((await fetchPath(`/reports/sessions/?offset=${offset}`)).status).toBe(400);
      expect(workSessions).not.toHaveBeenCalled();
    },
  );

  it("distinguishes unavailable session discovery from an empty visible list", async () => {
    expect((await fetchPath("/reports/sessions/")).body).toContain(
      "No work sessions are visible to you",
    );
    workSessions.mockResolvedValue({ available: false });
    const page = await fetchPath("/reports/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("Work sessions unavailable");
    expect(page.body).toContain("Day History");
    expect(page.body).not.toContain("No work sessions are visible to you");
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
  it.each([
    "/people/alice-alias/",
    "/day/2026-08-20/?person=alice-alias",
    "/week/2026-W34/",
    "/month/2026-08/",
  ])("links current owned sessions inside %s", async (route) => {
    workSessions.mockResolvedValue({
      available: true,
      sessions: [{ key: "agent:writer:dashboard:alice-work", label: "Current Alice work" }],
      nextOffset: 3,
    });
    const response = await fetchPath("/reports" + route);
    expect(response.status).toBe(200);
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

  it("keeps current metadata out of stored JSON and Markdown exports", async () => {
    const json = await fetchPath("/reports/day/2026-08-20/data.json");
    const markdown = await fetchPath("/reports/day/2026-08-20/report.md");
    expect(JSON.parse(json.body)).toEqual(report("day", "2026-08-20"));
    expect(markdown.body).toBe(
      renderMarkdown(report("day", "2026-08-20"), summary) + markdownSuffix,
    );
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    expect(workSessions).not.toHaveBeenCalled();
  });
});
