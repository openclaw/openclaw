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

  it("caps broad filesystem-root scans when the path appears after leading options", () => {
    const workspace = path.join(os.homedir(), "clawdbot-workspace");

    const result = maybeCapBroadFindTimeoutSec({
      command: "find -maxdepth 5 / -type d -iname '*homedaddy*'",
      workdir: workspace,
      explicitTimeoutSec: null,
    });

    expect(result.timeoutSec).toBe(20);
    expect(result.warning).toContain("broad find");
  });

  it("caps relative broad scans when workdir is the filesystem root", () => {
    const filesystemRoot = path.parse(os.homedir()).root;

    const result = maybeCapBroadFindTimeoutSec({
      command: "find . -type d -iname '*homedaddy*'",
      workdir: filesystemRoot,
      explicitTimeoutSec: null,
    });

    expect(result.timeoutSec).toBe(20);
    expect(result.warning).toContain("broad find");
  });

  it("caps broad home-directory scans when find uses leading -L", () => {
    const home = os.homedir();
    const workspace = path.join(home, "clawdbot-workspace");

    const result = maybeCapBroadFindTimeoutSec({
      command: "find -L $HOME -type d -iname '*homedaddy*'",
      workdir: workspace,
      explicitTimeoutSec: null,
    });

    expect(result.timeoutSec).toBe(20);
    expect(result.warning).toContain("broad find");
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

  it("does not cap relative scans that resolve inside the workspace", () => {
    const home = os.homedir();
    const workspace = path.join(home, "clawdbot-workspace");
    const nestedWorkdir = path.join(workspace, "src", "agents");

    const result = maybeCapBroadFindTimeoutSec({
      command: "find ../.. -maxdepth 5 -type d -iname '*homedaddy*'",
      workdir: nestedWorkdir,
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

  it("does not treat -prune inside -exec as a real traversal escape hatch", () => {
    const home = os.homedir();
    const workspace = path.join(home, "clawdbot-workspace");

    const result = maybeCapBroadFindTimeoutSec({
      command: `find ${home} -type f -exec grep --no-filename -prune {} \\;`,
      workdir: workspace,
      explicitTimeoutSec: null,
    });

    expect(result.timeoutSec).toBe(20);
    expect(result.warning).toContain("broad find");
  });

  it("does not let flags after shell chaining suppress the cap", () => {
    const home = os.homedir();
    const workspace = path.join(home, "clawdbot-workspace");

    const result = maybeCapBroadFindTimeoutSec({
      command: `find ${home} -type f && echo -prune`,
      workdir: workspace,
      explicitTimeoutSec: null,
    });

    expect(result.timeoutSec).toBe(20);
    expect(result.warning).toContain("broad find");
  });
});
