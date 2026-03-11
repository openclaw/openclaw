import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { maybeCapBroadFindTimeoutSec } from "./bash-tools.exec.js";

describe("exec broad find guard", () => {
  it("caps broad home-directory find scans when no explicit timeout is set", () => {
    const home = os.homedir();
    const workspace = path.join(home, "clawdbot-workspace");

    const result = maybeCapBroadFindTimeoutSec({
      command: `find ${home} -maxdepth 5 -type d -iname '*homedaddy*'`,
      workdir: workspace,
      explicitTimeoutSec: null,
    });

    expect(result.timeoutSec).toBe(20);
    expect(result.warning).toContain("broad find");
    expect(result.warning).toContain("20s");
  });

  it("does not cap workspace-scoped find scans", () => {
    const home = os.homedir();
    const workspace = path.join(home, "clawdbot-workspace");

    const result = maybeCapBroadFindTimeoutSec({
      command: `find ${workspace} -maxdepth 5 -type d -iname '*homedaddy*'`,
      workdir: workspace,
      explicitTimeoutSec: null,
    });

    expect(result.timeoutSec).toBeNull();
    expect(result.warning).toBeUndefined();
  });

  it("does not cap broad finds that already specify an explicit timeout", () => {
    const home = os.homedir();
    const workspace = path.join(home, "clawdbot-workspace");

    const result = maybeCapBroadFindTimeoutSec({
      command: `find ${home} -maxdepth 5 -type d -iname '*homedaddy*'`,
      workdir: workspace,
      explicitTimeoutSec: 300,
    });

    expect(result.timeoutSec).toBeNull();
    expect(result.warning).toBeUndefined();
  });

  it("does not cap broad finds that already prune noisy trees", () => {
    const home = os.homedir();
    const workspace = path.join(home, "clawdbot-workspace");

    const result = maybeCapBroadFindTimeoutSec({
      command: `find ${home} -path '${home}/Library' -prune -o -type d -iname '*homedaddy*'`,
      workdir: workspace,
      explicitTimeoutSec: null,
    });

    expect(result.timeoutSec).toBeNull();
    expect(result.warning).toBeUndefined();
  });
});
