import fs from "node:fs/promises";
import { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { readConfigFileSnapshotForWrite } from "openclaw/plugin-sdk/config-mutation";
import { afterEach, expect, it, vi } from "vitest";

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

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
function prepare({
  selector = "Shared",
  path = "/tmp/report.txt",
  remote = false,
  pluginsPath = "",
  action = "",
  confirmed = true,
} = {}) {
  const config: OpenClawConfig = {
    ...(remote ? { gateway: { mode: "remote" as const } } : {}),
    plugins: {
      entries: {
        "file-transfer": { config: { nodes: { [selector]: { allowReadPaths: [path] } } } },
      },
    },
  };
  readSnapshotMock.mockResolvedValue({
    snapshot: {
      valid: true,
      hash: "hash",
      path: "/tmp/openclaw.json",
      exists: true,
      raw: JSON.stringify(config),
      parsed: config,
      sourceConfig: config,
      resolved: config,
      runtimeConfig: config,
      config,
      issues: [],
      warnings: [],
      legacyIssues: [],
      includeProvenance: pluginsPath
        ? [
            {
              path: ["plugins"],
              kind: "single",
              targetPath: pluginsPath,
              hasSiblingOverrides: false,
            },
          ]
        : undefined,
    },
    writeOptions: {},
  });
  if (action) {
    prompterMock.select.mockResolvedValue(action);
    prompterMock.confirm.mockResolvedValue(confirmed);
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    if (confirmed) {
      mutateConfigMock.mockImplementation(
        async ({ mutate }: { mutate: (draft: Record<string, unknown>) => void }) => mutate({}),
      );
    }
  }
}
async function migrate(...flags: string[]) {
  const program = new Command();
  registerFileTransferCli(program);
  await program.parseAsync(["node", "openclaw", "file-transfer", "approvals", "migrate", ...flags]);
}
afterEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  if (stdinIsTtyDescriptor) {
    Object.defineProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
  vi.restoreAllMocks();
});

it("reports unresolved legacy permissions as JSON without prompting or writing", async () => {
  prepare({ path: "/tmp/report-*.txt" });
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await migrate("--json");
  expect(JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join(""))).toMatchObject({
    status: "needs-input",
    changed: false,
    command: "openclaw file-transfer approvals migrate",
  });
  expect(process.exitCode).toBe(2);
  expect(mutateConfigMock).not.toHaveBeenCalled();
});

it("requires an explicit decision for wildcard-selector permissions", async () => {
  prepare({ selector: "*", path: "/tmp/**", action: "keep-glob", confirmed: false });
  await migrate();
  expect(prompterMock.select).toHaveBeenCalledWith(
    expect.objectContaining({ message: "* · read · /tmp/**" }),
  );
  expect(mutateConfigMock).not.toHaveBeenCalled();
});

it.each(["", "/tmp/included-plugins.json"])(
  "migrates with downgrade recovery (%s)",
  async (pluginsPath) => {
    prepare({ pluginsPath, action: "exact" });
    if (pluginsPath) {
      const backupStat = { ino: 1, mtimeMs: 1, size: 1 } as Awaited<ReturnType<typeof fs.stat>>;
      vi.spyOn(fs, "stat")
        .mockRejectedValueOnce(new Error("missing"))
        .mockResolvedValueOnce(backupStat);
    }
    await migrate();
    expect(prompterMock.note).toHaveBeenCalledWith(
      expect.stringContaining("restore the adjacent config backup"),
      "Downgrade",
    );
    expect(mutateConfigMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ baseHash: "hash", writeOptions: {} }),
    );
    if (pluginsPath) {
      expect(vi.mocked(fs.stat).mock.calls).toEqual([
        [`${pluginsPath}.bak`],
        [`${pluginsPath}.bak`],
      ]);
      expect(prompterMock.outro).toHaveBeenCalledWith(
        expect.stringContaining(`${pluginsPath}.bak`),
      );
    }
  },
);

it("refuses to mutate local config in remote Gateway mode", async () => {
  prepare({ remote: true });
  await expect(migrate("--json")).rejects.toThrow("must run on the Gateway host");
  expect(mutateConfigMock).not.toHaveBeenCalled();
});
