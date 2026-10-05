import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createCodexNodeAppServerProcessOwner } from "./node-app-server-process-owner.js";

describe("worker Codex process custody", () => {
  it("retains cleanup authority after an unconfirmed stop and retries until exit", async () => {
    const events = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    Object.assign(events, { exitCode: null, signalCode: null });
    const active = new Set<() => Promise<void>>();
    const release = vi.fn();
    const terminate = vi.fn(async () => {
      if (terminate.mock.calls.length === 1) {
        return { exited: false as const, cleanup: "uncertain" as const };
      }
      Object.assign(events, { exitCode: 0 });
      return { exited: true as const, cleanup: "closed" as const };
    });
    const owner = createCodexNodeAppServerProcessOwner({
      child: () => events,
      unsubscribe: () => {},
      release,
      activeProcesses: active,
      terminate,
    });
    owner.observe(events);
    await expect(owner.stop()).rejects.toThrow("did not terminate");
    expect(active.has(owner.stop)).toBe(true);
    expect(release).not.toHaveBeenCalled();
    await owner.stop();
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(active.size).toBe(0);
    expect(release).toHaveBeenCalledOnce();
  });
});
