import fs, { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { parseTeamReportsConfig, resolveTeamReportsConfig } from "./config.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const minimal = { github: { token: "fixture-token", orgs: ["acme"] } };

const manifestSchema = buildJsonPluginConfigSchema(manifest.configSchema);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(open).mockReset();
});
afterAll(() => vi.doUnmock("node:fs/promises"));

it("defaults to automatic collection and accepts an explicit scheduling opt-out", () => {
  expect(parseTeamReportsConfig(minimal).schedule.enabled).toBe(true);
  for (const enabled of [true, false]) {
    const value = { ...minimal, schedule: { enabled } };
    expect(parseTeamReportsConfig(value).schedule.enabled).toBe(enabled);
    expect(manifestSchema.safeParse?.(value).success).toBe(true);
  }
});

it.each([
  [{ schedule: { enabled: "false" } }, true, undefined],
  [{ people: [], peopleFile: "/tmp/people.json" }, true, undefined],
  [{ basePath: "/api/channels" }, true, undefined],
  [{ basePath: "/reports/../admin" }, true, undefined],
  [{ displayTimezone: "Not/A_Zone" }, false, "IANA time zone"],
  [{ github: { ...minimal.github, ignoreCommentPatterns: ["["] } }, false, "regular expression"],
] as const)("rejects invalid config %j", (overrides, invalidManifest, message) => {
  const value = { ...minimal, ...overrides };
  expect(() => parseTeamReportsConfig(value)).toThrow(message);
  if (invalidManifest) {
    expect(manifestSchema.safeParse?.(value).success).toBe(false);
  }
});

it("reserves a mounted Control UI subtree while allowing the default root UI", () => {
  for (const uiPath of ["/", "/dashboard/"]) {
    expect(parseTeamReportsConfig(minimal, uiPath).basePath).toBe("/plugins/team-reports");
  }
  for (const basePath of ["/dashboard", "/dashboard/reports/"]) {
    expect(() => parseTeamReportsConfig({ ...minimal, basePath }, "/dashboard/")).toThrow(
      "Control UI base path",
    );
  }
});

it("loads a bounded people artifact only when resolving startup configuration", async () => {
  const peopleFile = join(tempDirs.make("team-reports-config-"), "people.json");
  const people = [
    { github: ["alice", "alice-work"], status: "archived", archivedAt: "2026-08-01" },
  ];
  await writeFile(peopleFile, JSON.stringify({ people }));
  const config = parseTeamReportsConfig({ ...minimal, peopleFile });
  const resolved = await resolveTeamReportsConfig(config, {});
  expect([resolved.people, resolved.github.token]).toEqual([people, "fixture-token"]);
  await writeFile(peopleFile, JSON.stringify({ people, unexpected: true }));
  await expect(resolveTeamReportsConfig(config, {})).rejects.toThrow();
  await writeFile(peopleFile, " ".repeat(2 * 1024 * 1024 + 1));
  await expect(resolveTeamReportsConfig(config, {})).rejects.toThrow("at most 2 MiB");
});

it("rejects a people file that grows beyond 2 MiB after inspection", async () => {
  const peopleFile = join(tempDirs.make("team-reports-growing-people-"), "people.json");
  await writeFile(peopleFile, JSON.stringify({ people: [{ github: ["alice"] }] }));
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await fs.open(...args);
    const stat = handle.stat.bind(handle);
    vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
      const inspected = await stat();
      await fs.appendFile(peopleFile, " ".repeat(2 * 1024 * 1024));
      return inspected;
    });
    return handle;
  });

  const config = parseTeamReportsConfig({ ...minimal, peopleFile });
  const result = await resolveTeamReportsConfig(config, {}).catch((error: unknown) => error);
  expect((await fs.stat(peopleFile)).size).toBeGreaterThan(2 * 1024 * 1024);
  expect(result).toMatchObject({
    message: "team-reports.peopleFile must be a regular JSON file of at most 2 MiB.",
  });
});
