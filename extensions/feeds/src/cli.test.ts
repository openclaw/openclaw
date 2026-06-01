import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  feedsBuildCommand,
  feedsDiffCommand,
  feedsInstallCommand,
  feedsListCommand,
  feedsNoticesCommand,
  feedsHashCommand,
  feedsSearchCommand,
  feedsSourcesCommand,
  feedsUpdatesCommand,
  feedsValidateCommand,
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

  it("reports available feed updates from an installed inventory", async () => {
    const feed = JSON.stringify({
      schemaVersion: 1,
      id: "company-approved",
      entries: [
        {
          type: "skill",
          id: "excel-review",
          version: "1.2.0",
          approval: { status: "approved" },
        },
        {
          type: "plugin",
          id: "calendar-helper",
          version: "1.0.0",
        },
      ],
    });
    const inventory = JSON.stringify({
      entries: [
        { type: "skill", id: "excel-review", version: "1.0.0" },
        { type: "plugin", id: "calendar-helper", version: "1.0.0" },
      ],
    });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json" }],
      files: {
        "/feeds/company.json": feed,
        "/installed.json": inventory,
      },
    });

    const exitCode = await feedsUpdatesCommand(
      { installed: "/installed.json", json: true },
      runtime,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(runtime.stdout).updates).toEqual([
      expect.objectContaining({
        type: "skill",
        id: "excel-review",
        installedVersion: "1.0.0",
        availableVersion: "1.2.0",
        approved: true,
      }),
    ]);
  });

  it("filters feed updates to approved entries", async () => {
    const feed = JSON.stringify({
      schemaVersion: 1,
      id: "company-approved",
      entries: [
        { type: "skill", id: "approved-skill", version: "2.0.0", approval: { status: "approved" } },
        { type: "skill", id: "draft-skill", version: "2.0.0" },
      ],
    });
    const inventory = JSON.stringify({
      entries: [
        { type: "skill", id: "approved-skill", version: "1.0.0" },
        { type: "skill", id: "draft-skill", version: "1.0.0" },
      ],
    });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json" }],
      files: {
        "/feeds/company.json": feed,
        "/installed.json": inventory,
      },
    });

    const exitCode = await feedsUpdatesCommand(
      { installed: "/installed.json", approvedOnly: true, json: true },
      runtime,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(runtime.stdout).updates.map((entry: { id: string }) => entry.id)).toEqual([
      "approved-skill",
    ]);
  });

  it("uses semver prerelease ordering for update notices", async () => {
    const feed = JSON.stringify({
      schemaVersion: 1,
      id: "company-approved",
      entries: [
        {
          type: "plugin",
          id: "calendar-helper",
          version: "1.0.0-beta.1",
          approval: { status: "approved" },
          install: { source: "clawhub", spec: "openclaw-calendar" },
        },
        {
          type: "plugin",
          id: "sheet-helper",
          version: "1.0.0",
          approval: { status: "approved" },
          install: { source: "clawhub", spec: "openclaw-sheet" },
        },
        {
          type: "plugin",
          id: "docs-helper",
          version: "1.0.0-rc.1",
          approval: { status: "approved" },
          install: { source: "clawhub", spec: "openclaw-docs" },
        },
      ],
    });
    const inventory = JSON.stringify({
      entries: [
        { type: "plugin", id: "calendar-helper", version: "1.0.0" },
        { type: "plugin", id: "sheet-helper", version: "1.0.0-beta.1" },
        { type: "plugin", id: "docs-helper", version: "1.0.0-beta.9" },
      ],
    });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json" }],
      files: {
        "/feeds/company.json": feed,
        "/installed.json": inventory,
      },
    });

    const exitCode = await feedsUpdatesCommand(
      { installed: "/installed.json", approvedOnly: true, json: true },
      runtime,
    );

    expect(exitCode).toBe(0);
    const updates = JSON.parse(runtime.stdout).updates;
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "sheet-helper",
          installedVersion: "1.0.0-beta.1",
          availableVersion: "1.0.0",
        }),
        expect.objectContaining({
          id: "docs-helper",
          installedVersion: "1.0.0-beta.9",
          availableVersion: "1.0.0-rc.1",
        }),
      ]),
    );
    expect(updates).toHaveLength(2);
  });

  it("reports subscriber update notices", async () => {
    const feed = JSON.stringify({
      schemaVersion: 1,
      id: "company-approved",
      entries: [
        {
          type: "plugin",
          id: "calendar-helper",
          version: "1.2.0",
          approval: { status: "approved" },
          install: { source: "clawhub", spec: "openclaw-calendar" },
        },
      ],
    });
    const inventory = JSON.stringify({
      entries: [{ type: "plugin", id: "calendar-helper", version: "1.0.0" }],
    });
    const runtime = createRuntime({
      sources: [{ id: "approved", url: "file:///feeds/company.json" }],
      files: {
        "/feeds/company.json": feed,
        "/installed.json": inventory,
      },
    });

    const exitCode = await feedsNoticesCommand(
      { installed: "/installed.json", approvedOnly: true, json: true },
      runtime,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(runtime.stdout).notices).toEqual([
      expect.objectContaining({
        type: "plugin",
        id: "calendar-helper",
        sourceId: "approved",
        installedVersion: "1.0.0",
        availableVersion: "1.2.0",
        approved: true,
        installCommand: "openclaw plugins install clawhub:openclaw-calendar",
      }),
    ]);
  });

  it("validates a local feed document and prints its integrity", async () => {
    const feed = JSON.stringify({
      schemaVersion: 1,
      id: "company-approved",
      entries: [{ type: "skill", id: "excel-review" }],
    });
    const integrity = `sha256:${createHash("sha256").update(feed).digest("hex")}`;
    const runtime = createRuntime({
      sources: [],
      files: { "/feeds/company.json": feed },
    });

    const exitCode = await feedsValidateCommand("/feeds/company.json", { json: true }, runtime);

    expect(exitCode).toBe(0);
    expect(JSON.parse(runtime.stdout)).toEqual({
      ok: true,
      id: "company-approved",
      entries: 1,
      integrity,
    });
  });

  it("prints a local feed document integrity hash", async () => {
    const feed = JSON.stringify({ schemaVersion: 1, id: "company-approved", entries: [] });
    const integrity = `sha256:${createHash("sha256").update(feed).digest("hex")}`;
    const runtime = createRuntime({
      sources: [],
      files: { "/feeds/company.json": feed },
    });

    const exitCode = await feedsHashCommand("/feeds/company.json", {}, runtime);

    expect(exitCode).toBe(0);
    expect(runtime.stdout).toBe(`${integrity}\n`);
  });

  it("rejects invalid local feed documents during validation", async () => {
    const runtime = createRuntime({
      sources: [],
      files: { "/feeds/broken.json": JSON.stringify({ schemaVersion: 1, id: "broken" }) },
    });

    const exitCode = await feedsValidateCommand("/feeds/broken.json", {}, runtime);

    expect(exitCode).toBe(2);
    expect(runtime.stderr).toContain("entries must be an array");
  });

  it("builds a curated feed artifact from local inventory rules", async () => {
    const inventory = JSON.stringify({
      schemaVersion: 1,
      id: "upstream",
      entries: [
        {
          type: "skill",
          id: "excel-review",
          version: "1.0.0",
          tags: ["m365", "approved"],
          approval: { status: "approved" },
        },
        { type: "plugin", id: "draft-plugin", tags: ["m365"] },
        {
          type: "skill",
          id: "blocked-skill",
          tags: ["m365", "blocked"],
          approval: { status: "approved" },
        },
      ],
    });
    const rules = JSON.stringify({
      includeTypes: ["skill"],
      includeTags: ["m365"],
      excludeTags: ["blocked"],
      requireApproval: true,
    });
    const runtime = createRuntime({
      sources: [],
      files: { "/feeds/inventory.json": inventory, "/feeds/rules.json": rules },
    });

    const exitCode = await feedsBuildCommand(
      {
        inventory: "/feeds/inventory.json",
        rules: "/feeds/rules.json",
        out: "/feeds/lobster-approved.json",
        id: "lobster-approved",
        generatedAt: "2026-05-28T00:00:00.000Z",
        json: true,
      },
      runtime,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(runtime.stdout)).toEqual(
      expect.objectContaining({
        ok: true,
        id: "lobster-approved",
        entries: 1,
        out: "/feeds/lobster-approved.json",
      }),
    );
    expect(JSON.parse(runtime.writes["/feeds/lobster-approved.json"])).toEqual({
      schemaVersion: 1,
      id: "lobster-approved",
      generatedAt: "2026-05-28T00:00:00.000Z",
      entries: [
        expect.objectContaining({
          type: "skill",
          id: "excel-review",
          approval: { status: "approved" },
        }),
      ],
    });
  });

  it("reports feed artifact deltas", async () => {
    const previous = JSON.stringify({
      schemaVersion: 1,
      id: "lobster-approved",
      entries: [
        {
          type: "skill",
          id: "excel-review",
          version: "1.0.0",
          name: "Excel Review",
          sha256: "old",
          approval: { status: "pending" },
        },
        { type: "plugin", id: "removed-plugin" },
      ],
    });
    const current = JSON.stringify({
      schemaVersion: 1,
      id: "lobster-approved",
      entries: [
        {
          type: "skill",
          id: "excel-review",
          version: "1.1.0",
          name: "Excel Review Pro",
          sha256: "new",
          approval: { status: "approved" },
        },
        { type: "skill", id: "new-skill" },
      ],
    });
    const runtime = createRuntime({
      sources: [],
      files: { "/feeds/previous.json": previous, "/feeds/current.json": current },
    });

    const exitCode = await feedsDiffCommand(
      { previous: "/feeds/previous.json", current: "/feeds/current.json", json: true },
      runtime,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(runtime.stdout)).toEqual(
      expect.objectContaining({
        added: [expect.objectContaining({ type: "skill", id: "new-skill" })],
        removed: [expect.objectContaining({ type: "plugin", id: "removed-plugin" })],
        updated: [{ type: "skill", id: "excel-review", previous: "1.0.0", current: "1.1.0" }],
        approvalChanged: [
          { type: "skill", id: "excel-review", previous: "pending", current: "approved" },
        ],
        metadataChanged: [{ type: "skill", id: "excel-review" }],
        hashChanged: [{ type: "skill", id: "excel-review", previous: "old", current: "new" }],
      }),
    );
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
  writes: Record<string, string>;
} {
  const runtime: FeedsCommandRuntime & {
    stdout: string;
    stderr: string;
    isTTY?: boolean;
    commands: string[][];
    writes: Record<string, string>;
  } = {
    stdout: "",
    stderr: "",
    commands: [],
    writes: {},
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
    async writeFile(path, value) {
      runtime.writes[path] = value;
    },
    async readConfigSnapshot(): Promise<any> {
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
