import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));
import {
  feedsInstallCommand,
  feedsListCommand,
  feedsSearchCommand,
  feedsSourcesCommand,
  type FeedsCommandRuntime,
} from "./cli.js";
import { MAX_FEED_DOCUMENT_BYTES } from "./feed-document.js";

describe("Feeds CLI", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("lists configured sources", async () => {
    const runtime = createRuntime({ sources: [{ id: "approved", url: "file:///feeds.json" }] });
    const exitCode = await feedsSourcesCommand({ json: true }, runtime);

    expect(exitCode).toBe(0);
    expect(JSON.parse(runtime.stdout).sources).toEqual([
      { id: "approved", url: "file:///feeds.json", enabled: true },
    ]);
  });

  it("lists an empty source set when no sources are configured", async () => {
    const runtime = createRuntime({});
    const exitCode = await feedsSourcesCommand({ json: true }, runtime);

    expect(exitCode).toBe(0);
    expect(JSON.parse(runtime.stdout).sources).toEqual([]);
    expect(runtime.stderr).toBe("");
  });

  it("loads file-backed feed entries", async () => {
    const feed = JSON.stringify({
      schemaVersion: 1,
      id: "company-approved",
      entries: [
        { type: "skill", id: "excel-review", version: "1.2.3", name: "Excel Review" },
        { type: "plugin", id: "teams-channel", tags: ["m365", "channel"] },
      ],
    });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json" }],
      files: { "/feeds/company.json": feed },
    });

    const exitCode = await feedsListCommand({ json: true }, runtime);

    expect(exitCode).toBe(0);
    expect(JSON.parse(runtime.stdout).entries).toEqual([
      expect.objectContaining({
        sourceId: "approved",
        feedId: "company-approved",
        id: "excel-review",
      }),
      expect.objectContaining({
        sourceId: "approved",
        feedId: "company-approved",
        id: "teams-channel",
      }),
    ]);
  });

  it("searches across entry metadata", async () => {
    const feed = JSON.stringify({
      schemaVersion: 1,
      id: "company-approved",
      entries: [
        { type: "skill", id: "excel-review", tags: ["m365"] },
        { type: "plugin", id: "calendar-helper", tags: ["outlook"] },
      ],
    });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json" }],
      files: { "/feeds/company.json": feed },
    });

    const exitCode = await feedsSearchCommand("outlook", { json: true }, runtime);

    expect(exitCode).toBe(0);
    expect(JSON.parse(runtime.stdout).entries).toEqual([
      expect.objectContaining({ id: "calendar-helper" }),
    ]);
  });

  it("loads HTTPS feeds through the SSRF guard", async () => {
    const release = vi.fn();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({ schemaVersion: 1, id: "company-approved", entries: [] }),
      ),
      release,
    });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "https://feeds.example.com/feed.json" }],
    });

    const exitCode = await feedsListCommand({ json: true }, runtime);

    expect(exitCode).toBe(0);
    expect(JSON.parse(runtime.stdout).entries).toEqual([]);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "https://feeds.example.com/feed.json",
      auditContext: "feeds.feed-document",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reports SSRF guard blocks for HTTPS feeds", async () => {
    fetchWithSsrFGuardMock.mockRejectedValue(new Error("SSRF blocked private network target"));
    const runtime = createRuntime({
      sources: [{ id: "private", url: "https://127.0.0.1/feed.json" }],
    });

    const exitCode = await feedsListCommand({ json: true }, runtime);

    expect(exitCode).toBe(2);
    expect(runtime.stderr).toContain("SSRF blocked private network target");
  });

  it("reports oversized HTTPS feed documents and releases the guarded dispatcher", async () => {
    const release = vi.fn();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("x".repeat(MAX_FEED_DOCUMENT_BYTES + 1)),
      release,
    });
    const runtime = createRuntime({
      sources: [{ id: "large", url: "https://feeds.example.com/large.json" }],
    });

    const exitCode = await feedsListCommand({ json: true }, runtime);

    expect(exitCode).toBe(2);
    expect(runtime.stderr).toContain(
      "Feed URL https://feeds.example.com/large.json response exceeds " +
        MAX_FEED_DOCUMENT_BYTES +
        " bytes.",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("checks pinned feed integrity while loading entries", async () => {
    const feed = JSON.stringify({ schemaVersion: 1, id: "company-approved", entries: [] });
    const integrity = `sha256:${createHash("sha256").update(feed).digest("hex").toUpperCase()}`;
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json", trust: "pinned", integrity }],
      files: { "/feeds/company.json": feed },
    });

    const exitCode = await feedsListCommand({ json: true }, runtime);

    expect(exitCode).toBe(0);
    expect(JSON.parse(runtime.stdout).entries).toEqual([]);
  });

  it("rejects pinned feed sources without integrity", async () => {
    const feed = JSON.stringify({ schemaVersion: 1, id: "company-approved", entries: [] });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json", trust: "pinned" }],
      files: { "/feeds/company.json": feed },
    });

    const exitCode = await feedsListCommand({ json: true }, runtime);

    expect(exitCode).toBe(2);
    expect(runtime.stderr).toContain("Feed source approved requires integrity for pinned trust.");
  });

  it("formats install hints without installing feed entries", async () => {
    const feed = JSON.stringify({
      schemaVersion: 1,
      id: "company-approved",
      entries: [
        {
          type: "plugin",
          id: "calendar-helper",
          name: "Calendar Helper",
          install: { source: "clawhub", spec: "openclaw-calendar" },
        },
        {
          type: "skill",
          id: "excel-review",
          install: { source: "clawhub", slug: "excel-review" },
        },
      ],
    });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json" }],
      files: { "/feeds/company.json": feed },
    });

    runtime.isTTY = true;

    const exitCode = await feedsSearchCommand("calendar", { type: "plugin" }, runtime);

    expect(exitCode).toBe(0);
    expect(runtime.stdout).toContain("approved\tplugin\tcalendar-helper - Calendar Helper");
    expect(runtime.stdout).toContain("Install: openclaw plugins install clawhub:openclaw-calendar");
    expect(runtime.stdout).not.toContain("excel-review");
  });

  it("quotes install hint specs from feed metadata", async () => {
    const feed = JSON.stringify({
      schemaVersion: 1,
      id: "company-approved",
      entries: [
        {
          type: "plugin",
          id: "unsafe-helper",
          install: { source: "npm", spec: "safe-package && curl example.invalid" },
        },
      ],
    });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json" }],
      files: { "/feeds/company.json": feed },
    });

    runtime.isTTY = true;

    const exitCode = await feedsSearchCommand("unsafe", { type: "plugin" }, runtime);

    expect(exitCode).toBe(0);
    expect(runtime.stdout).toContain(
      "Install: openclaw plugins install 'safe-package && curl example.invalid'",
    );
  });

  it("filters search results by entry type", async () => {
    const feed = JSON.stringify({
      schemaVersion: 1,
      id: "company-approved",
      entries: [
        { type: "plugin", id: "calendar-helper", tags: ["shared"] },
        { type: "skill", id: "calendar-review", tags: ["shared"] },
      ],
    });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json" }],
      files: { "/feeds/company.json": feed },
    });

    const exitCode = await feedsSearchCommand("shared", { type: "plugin", json: true }, runtime);

    expect(exitCode).toBe(0);
    expect(JSON.parse(runtime.stdout).entries).toEqual([
      expect.objectContaining({
        type: "plugin",
        id: "calendar-helper",
      }),
    ]);
  });

  it("rejects unsupported type filters", async () => {
    const runtime = createRuntime({ sources: [{ id: "approved", url: "file:///feeds.json" }] });
    const exitCode = await feedsListCommand({ type: "tool" }, runtime);

    expect(exitCode).toBe(2);
    expect(runtime.stderr).toContain("Invalid --type value. Expected skill or plugin.");
  });

  it("dry-runs an explicit feed-backed plugin install", async () => {
    const feed = JSON.stringify({
      schemaVersion: 1,
      id: "company-approved",
      entries: [
        {
          type: "plugin",
          id: "calendar-helper",
          install: { source: "clawhub", spec: "openclaw-calendar" },
        },
      ],
    });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json" }],
      files: { "/feeds/company.json": feed },
    });

    const exitCode = await feedsInstallCommand("calendar-helper", { dryRun: true }, runtime);

    expect(exitCode).toBe(0);
    expect(runtime.stdout).toBe("openclaw plugins install clawhub:openclaw-calendar\n");
    expect(runtime.commands).toEqual([]);
  });

  it("runs the existing install command for a selected feed entry", async () => {
    const feed = JSON.stringify({
      schemaVersion: 1,
      id: "company-approved",
      entries: [
        { type: "skill", id: "excel-review", install: { source: "clawhub", slug: "excel-review" } },
      ],
    });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json" }],
      files: { "/feeds/company.json": feed },
    });

    const exitCode = await feedsInstallCommand(
      "excel-review",
      { type: "skill", force: true },
      runtime,
    );

    expect(exitCode).toBe(0);
    expect(runtime.commands).toEqual([["skills", "install", "excel-review", "--force"]]);
  });

  it("enforces approved feed install metadata when configured", async () => {
    const feed = JSON.stringify({
      schemaVersion: 1,
      id: "company-approved",
      entries: [
        {
          type: "plugin",
          id: "calendar-helper",
          install: { source: "clawhub", spec: "openclaw-calendar" },
        },
      ],
    });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json" }],
      installPolicy: { mode: "enforce", requireApproval: true },
      files: { "/feeds/company.json": feed },
    });

    const exitCode = await feedsInstallCommand("calendar-helper", {}, runtime);

    expect(exitCode).toBe(2);
    expect(runtime.stderr).toContain("is not approved by feed metadata");
    expect(runtime.commands).toEqual([]);
  });

  it("defaults enforce mode to approved-only installs", async () => {
    const feed = JSON.stringify({
      schemaVersion: 1,
      id: "company-approved",
      entries: [
        {
          type: "plugin",
          id: "calendar-helper",
          install: { source: "clawhub", spec: "openclaw-calendar" },
        },
      ],
    });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json" }],
      installPolicy: { mode: "enforce" },
      files: { "/feeds/company.json": feed },
    });

    const exitCode = await feedsInstallCommand("calendar-helper", {}, runtime);

    expect(exitCode).toBe(2);
    expect(runtime.stderr).toContain("is not approved by feed metadata");
    expect(runtime.commands).toEqual([]);
  });

  it("defaults requireApproval without a mode to enforce", async () => {
    const feed = JSON.stringify({
      schemaVersion: 1,
      id: "company-approved",
      entries: [
        {
          type: "plugin",
          id: "calendar-helper",
          install: { source: "clawhub", spec: "openclaw-calendar" },
        },
      ],
    });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json" }],
      installPolicy: { requireApproval: true },
      files: { "/feeds/company.json": feed },
    });

    const exitCode = await feedsInstallCommand("calendar-helper", {}, runtime);

    expect(exitCode).toBe(2);
    expect(runtime.stderr).toContain("is not approved by feed metadata");
    expect(runtime.commands).toEqual([]);
  });

  it("warns but installs unapproved feed entries in warn mode", async () => {
    const feed = JSON.stringify({
      schemaVersion: 1,
      id: "company-approved",
      entries: [
        {
          type: "plugin",
          id: "calendar-helper",
          install: { source: "clawhub", spec: "openclaw-calendar" },
        },
      ],
    });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json" }],
      installPolicy: { mode: "warn", requireApproval: true },
      files: { "/feeds/company.json": feed },
    });

    const exitCode = await feedsInstallCommand("calendar-helper", {}, runtime);

    expect(exitCode).toBe(0);
    expect(runtime.stderr).toContain("Warning: Feed entry 'calendar-helper' is not approved");
    expect(runtime.commands).toEqual([["plugins", "install", "clawhub:openclaw-calendar"]]);
  });

  it("installs approved feed entries when enforcement is enabled", async () => {
    const feed = JSON.stringify({
      schemaVersion: 1,
      id: "company-approved",
      entries: [
        {
          type: "plugin",
          id: "calendar-helper",
          install: { source: "clawhub", spec: "openclaw-calendar" },
          approval: { status: "approved", owner: "platform" },
        },
      ],
    });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json" }],
      installPolicy: { mode: "enforce", requireApproval: true },
      files: { "/feeds/company.json": feed },
    });

    const exitCode = await feedsInstallCommand("calendar-helper", {}, runtime);

    expect(exitCode).toBe(0);
    expect(runtime.stderr).toBe("");
    expect(runtime.commands).toEqual([["plugins", "install", "clawhub:openclaw-calendar"]]);
  });

  it("requires disambiguation before installing duplicate feed entry ids", async () => {
    const feed = JSON.stringify({
      schemaVersion: 1,
      id: "company-approved",
      entries: [
        { type: "skill", id: "shared", install: { source: "clawhub", slug: "shared-skill" } },
        { type: "plugin", id: "shared", install: { source: "clawhub", spec: "shared-plugin" } },
      ],
    });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json" }],
      files: { "/feeds/company.json": feed },
    });

    const exitCode = await feedsInstallCommand("shared", {}, runtime);

    expect(exitCode).toBe(2);
    expect(runtime.stderr).toContain("Use --source or --type to choose one.");
    expect(runtime.commands).toEqual([]);
  });

  it("rejects feed install entries without supported install metadata", async () => {
    const feed = JSON.stringify({
      schemaVersion: 1,
      id: "company-approved",
      entries: [{ type: "plugin", id: "unknown", install: { source: "container" } }],
    });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json" }],
      files: { "/feeds/company.json": feed },
    });

    const exitCode = await feedsInstallCommand("unknown", {}, runtime);

    expect(exitCode).toBe(2);
    expect(runtime.stderr).toContain("does not include supported install metadata");
    expect(runtime.commands).toEqual([]);
  });
});

function createRuntime(params: {
  readonly sources?: readonly Record<string, unknown>[];
  readonly files?: Readonly<Record<string, string>>;
  readonly installPolicy?: Record<string, unknown>;
}): FeedsCommandRuntime & {
  stdout: string;
  stderr: string;
  isTTY?: boolean;
  commands: readonly string[][];
} {
  const runtime: FeedsCommandRuntime & {
    stdout: string;
    stderr: string;
    isTTY?: boolean;
    commands: string[][];
  } = {
    stdout: "",
    stderr: "",
    commands: [],
    writeStdout(value) {
      this.stdout += value;
    },
    error(value) {
      this.stderr += `${value}\n`;
    },
    async runOpenClawCommand(argv) {
      runtime.commands.push([...argv]);
      return 0;
    },
    async readConfigSnapshot() {
      return {
        valid: true,
        config: {
          plugins: {
            entries: {
              feeds: {
                enabled: true,
                config: { sources: params.sources, installPolicy: params.installPolicy },
              },
            },
          },
        },
      };
    },
    async readFile(path) {
      const value = params.files?.[path];
      if (value === undefined) {
        throw new Error(`missing test file ${path}`);
      }
      return value;
    },
  };
  return runtime;
}
