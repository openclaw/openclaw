import { describe, expect, it, onTestFinished } from "vitest";
import {
  createClient,
  createRuntime,
  CodexNativeSubagentMonitor,
  registerParent,
  notifyChildStarted,
} from "./native-subagent-monitor.test-support.js";

describe("native child yielded progress ownership", () => {
  it("authorizes progress only after successful yield and revokes it on the next parent turn", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    onTestFinished(() => client.close());
    const owner = await registerParent(monitor);
    await notifyChildStarted(client);
    expect(runtime.registerProgressOwner).not.toHaveBeenCalled();
    owner.authorizeProgressAfterSuccessfulYield?.();
    expect(runtime.registerProgressOwner).toHaveBeenCalledOnce();
    const args = runtime.registerProgressOwner.mock.calls[0]![0];
    const progress = runtime.registerProgressOwner.mock.results[0]!.value;
    expect(args.runIds).toEqual(["codex-thread:child-thread"]);
    expect(args.isCurrent()).toBe(false);
    await owner.unregister();
    expect(args.isCurrent()).toBe(true);
    expect(progress?.notify).toHaveBeenCalledOnce();
    const next = await registerParent(monitor);
    expect(args.isCurrent()).toBe(false);
    expect(progress?.dispose).toHaveBeenCalledOnce();
    await next.unregister();
    expect(args.isCurrent()).toBe(false);
  });

  it("never authorizes background progress just because a non-yielding parent exits", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    onTestFinished(() => client.close());
    const owner = await registerParent(monitor);
    await notifyChildStarted(client);
    await owner.unregister();
    expect(runtime.registerProgressOwner).not.toHaveBeenCalled();
  });
});
