import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  enqueueSystemEventEntry,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { startDeferredNotifyRun } from "./bash-tools.notify-on-exit-ack.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";
const requestHeartbeatMock = vi.hoisted(() => vi.fn());
const supervisorSpawnMock = vi.hoisted(() => vi.fn());
const randomMock = vi.hoisted(() => vi.fn(() => 0));
vi.mock("../infra/heartbeat-wake.js", () => ({ requestHeartbeat: requestHeartbeatMock }));
vi.mock("../infra/secure-random.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/secure-random.js")>()),
  generateSecureInt: randomMock,
}));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn: supervisorSpawnMock, getRecord: vi.fn() }),
}));
const QUEUE_KEY = "agent:main:notify-ack";
const startNotifyRun = (
  onSettledBeforeNotify?: Parameters<typeof startDeferredNotifyRun>[0]["onSettledBeforeNotify"],
) =>
  startDeferredNotifyRun({
    spawn: supervisorSpawnMock,
    sessionKey: QUEUE_KEY,
    onSettledBeforeNotify,
  });
const processTool = createProcessTool();
const execute = (action: "poll" | "clear", sessionId: string) =>
  processTool.execute(`${action}-${sessionId}`, { action, sessionId });
const poll = (sessionId: string) => execute("poll", sessionId);
const contexts = () => peekSystemEventEntries(QUEUE_KEY).map((event) => event.contextKey);
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000));
afterEach(() => {
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
it("isolates identical completions by their full producer identity", async () => {
  const first = await startNotifyRun();
  await first.finish();
  enqueueSystemEventEntry("unrelated", { sessionKey: QUEUE_KEY, contextKey: "marker" });
  const second = await startNotifyRun();
  await second.finish();
  expect([first.run.session.id, second.run.session.id]).toEqual(["amber-atlas", "amber-atlas-2"]);
  expect(contexts()).toEqual(["exec:amber-atlas", "marker", "exec:amber-atlas-2"]);
  await poll(second.run.session.id);
  expect(contexts()).toEqual(["exec:amber-atlas", "marker"]);
  await poll(second.run.session.id);
  expect(contexts()).toEqual(["exec:amber-atlas", "marker"]);
  await poll(first.run.session.id);
  expect(contexts()).toEqual(["marker"]);
});
it("lets settlement poll remove the receipt before heartbeat handoff", async () => {
  let sessionId = "";
  let pollResult: ReturnType<typeof poll> | undefined;
  const process = await startNotifyRun(() => {
    pollResult = poll(sessionId);
  });
  sessionId = process.run.session.id;
  await process.finish();
  expect((await expectDefined(pollResult, "settlement poll")).details).toMatchObject({
    status: "completed",
  });
  expect(contexts()).toEqual([]);
  expect(requestHeartbeatMock).not.toHaveBeenCalled();
});
it("does not recall a heartbeat snapshot taken before terminal poll", async () => {
  const process = await startNotifyRun();
  await process.finish();
  const snapshot = peekSystemEventEntries(QUEUE_KEY);
  await poll(process.run.session.id);
  expect(contexts()).toEqual([]);
  expect(snapshot.map((event) => event.contextKey)).toEqual([`exec:${process.run.session.id}`]);
});
it("keeps an unpolled completion deliverable after finished-session cleanup", async () => {
  const process = await startNotifyRun();
  await process.finish();
  await execute("clear", process.run.session.id);
  expect(contexts()).toEqual([`exec:${process.run.session.id}`]);
});
