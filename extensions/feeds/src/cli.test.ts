import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  feedsListCommand,
  feedsSearchCommand,
  feedsSourcesCommand,
  type FeedsCommandRuntime,
} from "./cli.js";

describe("Feeds CLI", () => {
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
});

function createRuntime(params: {
  readonly sources?: readonly Record<string, unknown>[];
  readonly files?: Readonly<Record<string, string>>;
}): FeedsCommandRuntime & { stdout: string; stderr: string; isTTY?: boolean } {
  const runtime: FeedsCommandRuntime & { stdout: string; stderr: string; isTTY?: boolean } = {
    stdout: "",
    stderr: "",
    writeStdout(value) {
      this.stdout += value;
    },
    error(value) {
      this.stderr += `${value}\n`;
    },
    async readConfigSnapshot() {
      return {
        valid: true,
        config: {
          plugins: { entries: { feeds: { enabled: true, config: { sources: params.sources } } } },
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
