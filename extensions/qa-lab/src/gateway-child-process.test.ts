import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { QaGatewayChildLifecycle } from "./gateway-child-lifecycle.js";
import {
  createQaGatewayChildLogCollector,
  monitorQaGatewayChildFailure,
  throwQaGatewayChildFailure,
} from "./gateway-child-process.js";

describe("monitorQaGatewayChildFailure", () => {
  async function expectUnexpectedExit(
    script: string,
    exitCode: number | null,
    signal: string | null,
  ) {
    const child = spawn(process.execPath, ["--eval", script], { stdio: "pipe" });
    const close = once(child, "close");
    const output = createQaGatewayChildLogCollector();
    const getFailure = monitorQaGatewayChildFailure(child, output);

    await close;

    const message = `gateway child exited unexpectedly (exitCode=${exitCode}, signal=${signal})`;
    expect(output.text()).toContain(message);
    expect(() => throwQaGatewayChildFailure(getFailure, () => output.text())).toThrow(message);
  }

  it.each([17, 0])("reports a Gateway exit with code %i", async (exitCode) => {
    await expectUnexpectedExit(`process.exit(${exitCode})`, exitCode, null);
  });

  it.runIf(process.platform !== "win32")("reports a POSIX signal exit", async () => {
    await expectUnexpectedExit("process.kill(process.pid, 'SIGTERM')", null, "SIGTERM");
  });

  it("keeps owner-requested shutdown separate from unexpected exit", async () => {
    const child = spawn(process.execPath, ["--eval", "process.stdin.resume()"], {
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
    const lifetime = new QaGatewayChildLifecycle();
    const owned = lifetime.register(child, null);
    const output = createQaGatewayChildLogCollector();
    const getFailure = monitorQaGatewayChildFailure(
      child,
      output,
      () => owned.settlement === undefined,
    );

    try {
      await expect(lifetime.stopProcess()).resolves.toEqual({
        process: "confirmed-stopped",
        errors: [],
      });
      expect(getFailure()).toBeNull();
      expect(output.text()).toBe("");
    } finally {
      await lifetime.stop();
    }
  });

  it("records the first pipe failure and stops the detached Gateway child", async () => {
    const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const close = once(child, "close");
    const output = createQaGatewayChildLogCollector();
    const getFailure = monitorQaGatewayChildFailure(child, output);
    const error = new Error("synthetic gateway stdout read failure");

    child.stdout?.destroy(error);
    child.stderr?.destroy(new Error("later stderr read failure"));

    await vi.waitFor(() => expect(getFailure()).toEqual({ source: "stdout", error }));
    await close;
    expect(output.text()).toContain(
      "gateway child stdout stream failed: synthetic gateway stdout read failure",
    );
    expect(output.text()).not.toContain("later stderr read failure");
    expect(() => throwQaGatewayChildFailure(getFailure, () => output.text())).toThrow(
      "gateway child stdout stream failed: synthetic gateway stdout read failure",
    );
  });
});
