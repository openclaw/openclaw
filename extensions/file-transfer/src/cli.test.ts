import fs from "node:fs/promises";
import { Command } from "commander";
import type { readConfigFileSnapshotForWrite } from "openclaw/plugin-sdk/config-mutation";
import { afterEach, expect, it, vi } from "vitest";
import { createCliTtyMock } from "../../../src/cli/test-runtime-capture.js";
import { createSnapshot } from "../../../src/config/mutate.test-support.js";

const { mutateConfigMock, prompterMock, readSnapshotMock } = vi.hoisted(() => ({
  mutateConfigMock: vi.fn(),
  prompterMock: {
    intro: vi.fn(),
    note: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    outro: vi.fn(),
  },
  readSnapshotMock: vi.fn<typeof readConfigFileSnapshotForWrite>(),
}));
// mock-isolation: Migration assertions must not read or write the operator's config.
vi.mock("openclaw/plugin-sdk/config-mutation", () => ({
  mutateConfigFile: mutateConfigMock,
  readConfigFileSnapshotForWrite: readSnapshotMock,
}));
// mock-isolation: Migration decisions use the fixture prompter, never an interactive terminal.
vi.mock("openclaw/plugin-sdk/setup-runtime", () => ({ createClackPrompter: () => prompterMock }));

import { registerFileTransferCli } from "./cli.js";

const tty = createCliTtyMock([process.stdin]);
const migrateArgv = ["node", "openclaw", "file-transfer", "approvals", "migrate"];
afterEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  tty.restore();
  vi.restoreAllMocks();
});

it.each(["JSON report", "cancel wildcard", "inline config", "included config", "remote Gateway"])(
  "migrates approvals: %s",
  async (mode) => {
    const cancelled = mode === "cancel wildcard";
    const writes = mode === "inline config" || mode === "included config";
    const pluginsPath = "/tmp/included-plugins.json";
    const selector = cancelled ? "*" : "Shared";
    const filePath = cancelled
      ? "/tmp/**"
      : mode === "JSON report"
        ? "/tmp/report-*.txt"
        : "/tmp/report.txt";
    const nodes = { [selector]: { allowReadPaths: [filePath] } };
    const snapshot = createSnapshot({
      hash: "hash",
      sourceConfig: {
        gateway: { mode: mode === "remote Gateway" ? "remote" : "local" },
        plugins: { entries: { "file-transfer": { config: { nodes } } } },
      },
    });
    if (mode === "included config") {
      snapshot.includeProvenance = [
        { path: ["plugins"], kind: "single", targetPath: pluginsPath, hasSiblingOverrides: false },
      ];
      const backupStat = { ino: 1, mtimeMs: 1, size: 1 } as Awaited<ReturnType<typeof fs.stat>>;
      vi.spyOn(fs, "stat")
        .mockRejectedValueOnce(new Error("missing"))
        .mockResolvedValueOnce(backupStat);
    }
    readSnapshotMock.mockResolvedValue({ snapshot, writeOptions: {} });
    if (writes || cancelled) {
      tty.set(true);
      prompterMock.select.mockResolvedValue(cancelled ? "keep-glob" : "exact");
      prompterMock.confirm.mockResolvedValue(writes);
    }
    if (writes) {
      mutateConfigMock.mockImplementation(
        async ({ mutate }: { mutate: (draft: Record<string, unknown>) => void }) => mutate({}),
      );
    }
    const stdout =
      mode === "JSON report" ? vi.spyOn(process.stdout, "write").mockReturnValue(true) : undefined;
    const program = new Command();
    registerFileTransferCli(program);
    const flags = writes || cancelled ? [] : ["--json"];
    const run = program.parseAsync([...migrateArgv, ...flags]);
    if (mode === "remote Gateway") {
      await expect(run).rejects.toThrow("must run on the Gateway host");
    } else {
      await run;
    }
    expect(mutateConfigMock).toHaveBeenCalledTimes(writes ? 1 : 0);
    if (stdout) {
      expect(JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join(""))).toMatchObject({
        status: "needs-input",
        changed: false,
        command: "openclaw file-transfer approvals migrate",
      });
      expect(process.exitCode).toBe(2);
    }
    if (cancelled) {
      expect(prompterMock.select).toHaveBeenCalledWith(
        expect.objectContaining({ message: "* · read · /tmp/**" }),
      );
    }
    if (writes) {
      expect(prompterMock.note).toHaveBeenCalledWith(
        expect.stringContaining("restore the adjacent config backup"),
        "Downgrade",
      );
      expect(mutateConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({ baseHash: "hash", writeOptions: {} }),
      );
      if (mode === "included config") {
        expect(prompterMock.outro.mock.lastCall?.[0]).toContain(`${pluginsPath}.bak`);
      }
    }
  },
);
