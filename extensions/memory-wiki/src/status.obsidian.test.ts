// Configured integration, requested CLI, and detected executable are separate facts.
import { describe, expect, it } from "vitest";
import { resolveMemoryWikiConfig } from "./config.js";
import {
  buildMemoryWikiDoctorReport,
  renderMemoryWikiDoctor,
  renderMemoryWikiStatus,
  resolveMemoryWikiStatus,
} from "./status.js";

const cases = [
  { enabled: false, useOfficialCli: false, available: false },
  { enabled: false, useOfficialCli: false, available: true },
  { enabled: false, useOfficialCli: true, available: false },
  { enabled: false, useOfficialCli: true, available: true },
  { enabled: true, useOfficialCli: false, available: false },
  { enabled: true, useOfficialCli: false, available: true },
  { enabled: true, useOfficialCli: true, available: false },
  { enabled: true, useOfficialCli: true, available: true },
];

describe("Obsidian integration status", () => {
  it.each(cases)(
    "shows enabled=$enabled, useOfficialCli=$useOfficialCli, available=$available without changing state",
    async ({ enabled, useOfficialCli, available }) => {
      const config = resolveMemoryWikiConfig(
        { obsidian: { enabled, useOfficialCli } },
        { homedir: "/home/tester" },
      );
      const command = available ? "/usr/local/bin/obsidian" : null;
      const status = await resolveMemoryWikiStatus(config, {
        pathExists: async () => false,
        resolveCommand: async () => command,
      });
      const requested = enabled && useOfficialCli;
      expect(status.obsidianCli).toEqual({ enabled, requested, available, command });
      const jsonBefore = JSON.stringify(status);
      const report = buildMemoryWikiDoctorReport(status);
      const reportBefore = JSON.stringify(report);
      const integrationLine = `Obsidian integration: ${enabled ? "enabled" : "disabled"}`;
      const cliLine = `Obsidian CLI: ${available ? "available" : "missing"}${requested ? " (requested)" : ""}`;

      for (const rendered of [renderMemoryWikiStatus(status), renderMemoryWikiDoctor(report)]) {
        const lines = rendered.split("\n");
        expect(lines.filter((line) => line.startsWith("Obsidian integration:"))).toEqual([
          integrationLine,
        ]);
        expect(lines.filter((line) => line.startsWith("Obsidian CLI:"))).toEqual([cliLine]);
      }
      const codes =
        requested && !available ? ["vault-missing", "obsidian-cli-missing"] : ["vault-missing"];
      expect(status.warnings.map((warning) => warning.code)).toEqual(codes);
      expect(report.warningCount).toBe(codes.length);
      expect(report.fixes.map((fix) => fix.code)).toEqual(codes);
      expect(report.healthy).toBe(false);
      expect(JSON.stringify(status)).toBe(jsonBefore);
      expect(JSON.stringify(report)).toBe(reportBefore);
    },
  );
});
