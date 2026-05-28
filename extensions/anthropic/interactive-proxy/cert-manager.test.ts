import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInteractiveProxyStateDir } from "./cert-manager.js";

// resolveInteractiveProxyStateDir is the state-dir resolver used to decide
// where the per-user proxy CA + leaf key cache lands. It must mirror
// src/utils.ts:resolveConfigDir so an operator who runs the gateway with
// OPENCLAW_STATE_DIR also sees the cert cache land under that root —
// keeping per-profile / multi-instance state-dir isolation working for
// security-sensitive signing material. Tested inline here because the
// wrapper child can't import src/utils.ts at runtime; the resolver is
// duplicated and these tests lock the behaviour in.
describe("resolveInteractiveProxyStateDir", () => {
  it("returns homedir()/.openclaw when OPENCLAW_STATE_DIR is unset", () => {
    expect(resolveInteractiveProxyStateDir({})).toBe(join(homedir(), ".openclaw"));
  });

  it("returns homedir()/.openclaw when OPENCLAW_STATE_DIR is an empty string", () => {
    expect(resolveInteractiveProxyStateDir({ OPENCLAW_STATE_DIR: "" })).toBe(
      join(homedir(), ".openclaw"),
    );
  });

  it("returns homedir()/.openclaw when OPENCLAW_STATE_DIR is whitespace-only", () => {
    expect(resolveInteractiveProxyStateDir({ OPENCLAW_STATE_DIR: "   " })).toBe(
      join(homedir(), ".openclaw"),
    );
  });

  it("honours an absolute OPENCLAW_STATE_DIR override verbatim", () => {
    const abs = process.platform === "win32" ? "D:\\openclaw-state" : "/var/lib/openclaw-state";
    expect(resolveInteractiveProxyStateDir({ OPENCLAW_STATE_DIR: abs })).toBe(abs);
  });

  it("expands `~` to homedir()", () => {
    expect(resolveInteractiveProxyStateDir({ OPENCLAW_STATE_DIR: "~" })).toBe(homedir());
  });

  it("expands `~/Documents/openclaw` to homedir()/Documents/openclaw", () => {
    expect(resolveInteractiveProxyStateDir({ OPENCLAW_STATE_DIR: "~/Documents/openclaw" })).toBe(
      join(homedir(), "Documents/openclaw"),
    );
  });

  it("falls back to homedir()/.openclaw when override is relative (non-absolute, no `~`)", () => {
    // Relative paths are ambiguous wrt to cwd at child-spawn time; fall back to
    // the safe default rather than guessing.
    expect(resolveInteractiveProxyStateDir({ OPENCLAW_STATE_DIR: "relative/state-dir" })).toBe(
      join(homedir(), ".openclaw"),
    );
  });

  it("uses the parent-resolved OPENCLAW_INTERACTIVE_PROXY_STATE_DIR verbatim when absolute", () => {
    // Preferred path: the gateway runs the canonical resolveConfigDir() (which
    // honours OPENCLAW_CONFIG_PATH, OPENCLAW_HOME/effective-home and relative
    // state-dir resolution that this child can't replicate) and hands us the
    // final absolute path. Per-profile cert isolation depends on us using it.
    const abs = process.platform === "win32" ? "D:\\profile-a\\.openclaw" : "/home/a/.openclaw";
    expect(resolveInteractiveProxyStateDir({ OPENCLAW_INTERACTIVE_PROXY_STATE_DIR: abs })).toBe(
      abs,
    );
  });

  it("prefers OPENCLAW_INTERACTIVE_PROXY_STATE_DIR over OPENCLAW_STATE_DIR", () => {
    const parentResolved =
      process.platform === "win32" ? "D:\\profile-b\\.openclaw" : "/home/b/.openclaw";
    const stateDir = process.platform === "win32" ? "D:\\other-state" : "/var/other-state";
    expect(
      resolveInteractiveProxyStateDir({
        OPENCLAW_INTERACTIVE_PROXY_STATE_DIR: parentResolved,
        OPENCLAW_STATE_DIR: stateDir,
      }),
    ).toBe(parentResolved);
  });

  it("ignores a relative OPENCLAW_INTERACTIVE_PROXY_STATE_DIR and falls through", () => {
    const abs = process.platform === "win32" ? "D:\\openclaw-state" : "/var/lib/openclaw-state";
    expect(
      resolveInteractiveProxyStateDir({
        OPENCLAW_INTERACTIVE_PROXY_STATE_DIR: "relative/dir",
        OPENCLAW_STATE_DIR: abs,
      }),
    ).toBe(abs);
  });
});
