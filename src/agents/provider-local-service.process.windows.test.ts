import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import {
  forceStopLocalServiceProcess,
  trackLocalServiceProcess,
} from "./provider-local-service-process.js";

it.runIf(process.platform === "win32")(
  "force-stops an owned local service without System32 in PATH",
  async ({ signal }) => {
    const child = spawn(
      process.execPath,
      ["-e", 'process.send("ready"); setInterval(() => {}, 1000);'],
      {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      },
    );
    const closed = once(child, "close");
    const originalPath = process.env.PATH;
    try {
      await withinTest(
        Promise.race([
          once(child, "message"),
          closed.then(() => {
            throw new Error("Service fixture exited before readiness");
          }),
        ]),
        signal,
      );
      const owned = trackLocalServiceProcess(child);
      process.env.PATH = "C:/nonexistent-openclaw-service-path";
      forceStopLocalServiceProcess(owned);
      await withinTest(Promise.all(owned.pendingSignals.values()), signal);
      expect(() => process.kill(child.pid!, 0)).toThrow();
      await withinTest(closed, signal);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      child.kill("SIGKILL");
      await closed;
    }
  },
);
