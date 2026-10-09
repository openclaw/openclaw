import { describe, expect, it, vi } from "vitest";
import {
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  notifyChildStarted,
  threadRead,
} from "./native-subagent-monitor.test-support.js";

describe("Codex native input target scope", () => {
  it.each([
    ["unknown", "idle"],
    ["unknown", "notLoaded"],
    ["unknown", "active"],
    ["unrelated root", "idle"],
    ["unrelated root", "notLoaded"],
    ["unrelated root", "active"],
    ["unrelated child", "idle"],
    ["unrelated child", "notLoaded"],
    ["unrelated child", "active"],
  ] as const)("rejects %s input with %s target state", async (kind, status) => {
    const client = createClient();
    const monitor = new CodexNativeSubagentMonitor(client.client, createRuntime(), {
      recoveryPollDelaysMs: [],
    });
    const sender = await monitor.registerParent({
      parentThreadId: "parent-thread",
      modelSource: undefined,
    });
    sender.bindTurn("sender-turn");
    const target = "00000000-0000-4000-8000-000000000042";
    const foreign = await monitor.registerParent({
      parentThreadId: kind === "unrelated root" ? target : "unrelated-root",
      modelSource: undefined,
    });
    foreign.bindTurn("foreign-turn");
    if (kind === "unrelated child") {
      await notifyChildStarted(client, "unrelated-root", target, "/root/worker");
    }
    const metadata = threadRead({ childThreadId: target, threadStatus: status });
    metadata.thread.modelProvider = "test-provider";
    if (kind !== "unrelated child") {
      delete metadata.thread.parentThreadId;
      delete metadata.thread.source;
    }
    client.setThreadRead(target, metadata);
    client.request.mockClear();
    const nativeWrite = vi.fn();
    try {
      await expect(
        monitor
          .prepareModelInput({
            threadId: "parent-thread",
            turnId: "sender-turn",
            itemId: "input",
            target,
            readQualification: () => undefined,
            assertCurrent: () => {},
          })
          .then(nativeWrite),
      ).rejects.toThrow("outside the sender's admitted tree");
      expect(nativeWrite).not.toHaveBeenCalled();
      if (kind !== "unknown") {
        expect(client.request).not.toHaveBeenCalledWith(
          "thread/read",
          { threadId: target, includeTurns: false },
          expect.anything(),
        );
      } else {
        // Cold same-tree recovery needs native metadata, never turn history.
        expect(client.request).toHaveBeenCalledWith(
          "thread/read",
          { threadId: target, includeTurns: false },
          expect.anything(),
        );
      }
    } finally {
      await monitor.dispose();
      await sender.unregister();
      await foreign.unregister();
    }
  });
});
