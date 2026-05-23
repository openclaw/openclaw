import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __testing } from "./daemon.js";

describe("signal daemon args", () => {
  it("expands home-relative configPath before passing it to signal-cli", () => {
    expect(
      __testing.buildDaemonArgs({
        cliPath: "signal-cli",
        configPath: "~/.openclaw/signal-cli",
        httpHost: "127.0.0.1",
        httpPort: 8080,
      }),
    ).toEqual([
      "--config",
      path.join(os.homedir(), ".openclaw/signal-cli"),
      "daemon",
      "--http",
      "127.0.0.1:8080",
      "--no-receive-stdout",
    ]);
  });
});
