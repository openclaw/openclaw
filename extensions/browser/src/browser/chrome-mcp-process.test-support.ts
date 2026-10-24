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

async function afterCensus<T>(operation: Promise<T>, isCensus: boolean): Promise<T> {
  const result = await operation;
  if (isCensus) {
    await fixture.mocks?.afterCensus?.();
  }
  return result;
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readdir = async (...args: Parameters<typeof actual.readdir>) => {
    if (args[0] === "/proc" && fixture.mocks?.listProcesses) {
      const rows = await fixture.mocks.listProcesses();
      fixture.linuxRows = new Map(rows.map((row) => [row.pid, row]));
      return rows.map((row) => String(row.pid));
    }
    return afterCensus(actual.readdir(...args), args[0] === "/proc");
  };
  const readFile = async (...args: Parameters<typeof actual.readFile>) => {
    const match = typeof args[0] === "string" ? /^\/proc\/(\d+)\/stat$/.exec(args[0]) : null;
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
      const mocks = fixture.mocks;
      if (
        args[0] === "taskkill" &&
        (mocks?.platform || mocks?.listProcesses || mocks?.taskkillProcessTree)
      ) {
        if (!mocks.taskkillProcessTree) {
          throw new Error("synthetic process census has no taskkill handler");
        }
        await mocks.taskkillProcessTree(Number(args[1][1]));
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "powershell.exe" && mocks?.listProcesses) {
        const rows = await mocks.listProcesses();
        return {
          stdout: rows.map((row) => `${row.pid}\t${row.ppid}\t${row.identity}\tfixture`).join("\n"),
          stderr: "",
        };
      }
      return afterCensus(actual.runExec(...args), args[0] === "ps" || args[0] === "powershell.exe");
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
      if (signal !== "SIGTERM" && signal !== "SIGKILL") {
        throw new Error("expected a Chrome MCP cleanup signal");
      }
      killProcess(pid, signal);
      return true;
    });
    restoreKill = () => kill.mockRestore();
  }
}
