import fs, { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
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
afterAll(() => {
  vi.doUnmock("node:fs/promises");
});

describe("Team Reports configuration", () => {
  it("rejects ambiguous people configuration in both validation surfaces", () => {
    const value = { ...minimal, people: [], peopleFile: "/tmp/people.json" };
    expect(() => parseTeamReportsConfig(value)).toThrow();
    expect(manifestSchema.safeParse?.(value).success).toBe(false);
  });

  it.each(["/api/channels", "/reports/../admin"])(
    "rejects unsafe or reserved route root %s",
    (basePath) => {
      expect(() => parseTeamReportsConfig({ ...minimal, basePath })).toThrow();
      expect(manifestSchema.safeParse?.({ ...minimal, basePath }).success).toBe(false);
    },
  );

  it("reserves a mounted Control UI subtree while allowing the default root UI", () => {
    expect(parseTeamReportsConfig(minimal, "/").basePath).toBe("/plugins/team-reports");
    expect(parseTeamReportsConfig(minimal, "/dashboard/").basePath).toBe("/plugins/team-reports");
    for (const basePath of ["/dashboard", "/dashboard/reports/"]) {
      expect(() => parseTeamReportsConfig({ ...minimal, basePath }, "/dashboard/")).toThrow(
        "Control UI base path",
      );
    }
  });

  it("rejects invalid IANA zones and comment regular expressions before starting collection", () => {
    expect(() => parseTeamReportsConfig({ ...minimal, displayTimezone: "Not/A_Zone" })).toThrow(
      "IANA time zone",
    );
    expect(() =>
      parseTeamReportsConfig({ github: { ...minimal.github, ignoreCommentPatterns: ["["] } }),
    ).toThrow("regular expression");
  });

  it("loads a bounded people artifact only when resolving startup configuration", async () => {
    const directory = tempDirs.make("team-reports-config-");
    const peopleFile = join(directory, "people.json");
    const people = [
      { github: ["alice", "alice-work"], status: "archived", archivedAt: "2026-08-01" },
    ];
    await writeFile(peopleFile, JSON.stringify({ people }));
    const config = parseTeamReportsConfig({ ...minimal, peopleFile });
    const resolved = await resolveTeamReportsConfig(config, {});
    expect(resolved.people).toEqual(people);
    expect(resolved.github.token).toBe("fixture-token");
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
});
