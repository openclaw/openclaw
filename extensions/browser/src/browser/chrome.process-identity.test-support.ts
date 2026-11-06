import { readProcessIdentity } from "@openclaw/proc-safe/identity";
import { vi } from "vitest";

export function createChromeProcessIdentityFixture(pid: number, startTime: string) {
  const processState = { alive: true, startTime };
  const nativeIdentity = vi.mocked(readProcessIdentity);
  const readRealIdentity = nativeIdentity.getMockImplementation()!;
  nativeIdentity.mockImplementation((candidate) =>
    candidate === pid
      ? {
          pid,
          parentPid: process.pid,
          startTimeMicros: Date.parse(`${processState.startTime} UTC`) * 1_000,
          startTimeResolutionMicros: 1_000_000,
          exited: !processState.alive,
        }
      : readRealIdentity(candidate),
  );
  const killSpy = vi.spyOn(process, "kill").mockImplementation(((candidate, signal) => {
    if (candidate === pid && signal === 0 && !processState.alive) {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    }
    return true;
  }) as typeof process.kill);
  return {
    processState,
    killSpy,
    restore: () => {
      nativeIdentity.mockImplementation(readRealIdentity);
      killSpy.mockRestore();
    },
  };
}
