import { setTimeout as delay } from "node:timers/promises";
import { isPidAlive, runExec } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runExec: vi.fn(),
  isPidAlive: vi.fn(() => true),
}));

vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: vi.fn(async () => {}),
}));

export type AcpxProcessSystemFixture = {
  listProcesses?: () => Promise<Array<{ pid: number; ppid: number; command: string }>>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  platform?: NodeJS.Platform;
  sleep?: (ms: number) => Promise<void>;
};

export function mockAcpxProcessSystem(fixture: AcpxProcessSystemFixture = {}) {
  vi.spyOn(process, "platform", "get").mockReturnValue(fixture.platform ?? "linux");
  const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    fixture.killProcess?.(pid, signal as NodeJS.Signals);
    return true;
  });
  vi.mocked(runExec)
    .mockReset()
    .mockImplementation(async () => ({
      stdout: ((await fixture.listProcesses?.()) ?? [])
        .map(({ pid, ppid, command }) => `${pid} ${ppid} ${command}`)
        .join("\n"),
      stderr: "",
    }));
  vi.mocked(isPidAlive).mockReset().mockReturnValue(true);
  vi.mocked(delay)
    .mockReset()
    .mockImplementation(async (ms) => {
      await fixture.sleep?.(ms ?? 0);
    });
  return { runExec: vi.mocked(runExec), kill };
}

afterEach(() => {
  vi.restoreAllMocks();
});
