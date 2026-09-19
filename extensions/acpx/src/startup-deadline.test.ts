import type { AcpProcessStarted } from "acpx/runtime";
import { expect, it } from "vitest";
import { AcpxStartupDeadline } from "./startup-deadline.js";

const secret = "sk-live-0123456789abcdefghijklmnopqrstuv";

function started(launchId: string): AcpProcessStarted {
  return {
    launchId,
    scope: { kind: "runtime-session", sessionKey: "agent:main:acp:late" },
    command: "my-acp",
    args: [],
    cwd: "/",
    pid: 4242,
    startedAt: new Date(0).toISOString(),
  };
}

it("releases a startup that resolves after the stop signal and redacts the error", async () => {
  let resolveStartup: (handle: string) => void = () => {};
  const signals: string[] = [];
  const released: string[] = [];
  const deadline = new AcpxStartupDeadline({
    killGraceMs: 50,
    // The peer finishes startup just as it is being stopped.
    kill: (_pid, signal) => {
      signals.push(signal);
      resolveStartup("late-handle");
    },
  });
  await expect(
    deadline.run({
      sessionKey: "agent:main:acp:late",
      agent: "late",
      command: ["my-acp", "--api-key", secret],
      timeoutMs: 20,
      run: () => {
        deadline.noteSpawned(started("launch-1"));
        return new Promise<string>((resolve) => {
          resolveStartup = resolve;
        });
      },
      releaseLate: async (handle) => {
        released.push(handle);
      },
    }),
  ).rejects.toSatisfy((error: Error & { detailCode?: string }) => {
    expect(error.detailCode).toBe("ACP_HANDSHAKE_TIMEOUT");
    expect(error.message).toContain('ACP agent "late"');
    expect(error.message).not.toContain(secret);
    return true;
  });
  expect(signals).toEqual(["SIGTERM"]);
  expect(released).toEqual(["late-handle"]);
});
