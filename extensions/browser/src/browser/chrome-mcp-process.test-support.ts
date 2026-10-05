import { vi } from "vitest";
import type { ChromeMcpProcessSnapshot } from "./chrome-mcp-contracts.js";

type ProcessMocks = {
  platform?: NodeJS.Platform;
  listProcesses?: () => Promise<ChromeMcpProcessSnapshot[]>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  taskkillProcessTree?: (pid: number) => Promise<void>;
  afterCensus?: () => Promise<void>;
};

const fixture = vi.hoisted(() => ({
  mocks: undefined as ProcessMocks | undefined,
  linuxRows: new Map<number, ChromeMcpProcessSnapshot>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readdir = async (...args: Parameters<typeof actual.readdir>) => {
    if (args[0] === "/proc" && fixture.mocks?.listProcesses) {
      const rows = await fixture.mocks.listProcesses();
      fixture.linuxRows = new Map(rows.map((row) => [row.pid, row]));
      return rows.map((row) => String(row.pid));
    }
    const result = await actual.readdir(...args);
    if (args[0] === "/proc") {
      await fixture.mocks?.afterCensus?.();
    }
    return result;
  };
  const readFile = async (...args: Parameters<typeof actual.readFile>) => {
    const match = /^\/proc\/(\d+)\/stat$/.exec(String(args[0]));
    if (match && fixture.mocks?.listProcesses) {
      const row = fixture.linuxRows.get(Number(match[1]));
      if (!row) {
        throw new Error("fixture process exited");
      }
      return `${row.pid} (fixture) S ${row.ppid} ${Array(17).fill("0").join(" ")} ${row.identity}`;
    }
    return actual.readFile(...args);
  };
  return { ...actual, readdir, readFile, default: { ...actual, readdir, readFile } };
});

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return {
    ...actual,
    setTimeout: (...args: Parameters<typeof actual.setTimeout>) =>
      fixture.mocks?.sleep && args[0] === 250
        ? fixture.mocks.sleep(args[0])
        : actual.setTimeout(...args),
  };
});

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return {
    ...actual,
    runExec: async (...args: Parameters<typeof actual.runExec>) => {
      if (
        args[0] === "taskkill" &&
        (fixture.mocks?.platform ||
          fixture.mocks?.listProcesses ||
          fixture.mocks?.taskkillProcessTree)
      ) {
        if (!fixture.mocks.taskkillProcessTree) {
          throw new Error("synthetic process census has no taskkill handler");
        }
        await fixture.mocks.taskkillProcessTree(Number(args[1][1]));
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "powershell.exe" && fixture.mocks?.listProcesses) {
        const rows = await fixture.mocks.listProcesses();
        return {
          stdout: rows.map((row) => `${row.pid}\t${row.ppid}\t${row.identity}\tfixture`).join("\n"),
          stderr: "",
        };
      }
      const result = await actual.runExec(...args);
      if (args[0] === "ps" || args[0] === "powershell.exe") {
        await fixture.mocks?.afterCensus?.();
      }
      return result;
    },
  };
});

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
let restoreKill: (() => void) | undefined;

export function resetChromeMcpProcessMocks(): void {
  restoreKill?.();
  restoreKill = undefined;
  Object.defineProperty(process, "platform", platformDescriptor);
  fixture.mocks = undefined;
  fixture.linuxRows.clear();
}

export function mockChromeMcpProcesses(mocks: ProcessMocks): void {
  resetChromeMcpProcessMocks();
  fixture.mocks = mocks;
  if (mocks.platform) {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: mocks.platform });
  }
  const killProcess = mocks.killProcess;
  if (killProcess || mocks.listProcesses || mocks.platform) {
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (!killProcess) {
        throw new Error("synthetic process census has no signal handler");
      }
      if (typeof signal !== "string") {
        throw new Error("expected a named process signal");
      }
      killProcess(pid, signal);
      return true;
    });
    restoreKill = () => kill.mockRestore();
  }
}
