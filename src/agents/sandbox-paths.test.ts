import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSandboxPath } from "./sandbox-paths.js";

describe("resolveSandboxPath", () => {
  it("maps legacy /home/node/.openclaw paths onto a host-backed .openclaw root", () => {
    const root = path.join("/Users", "chris", ".openclaw");
    expect(
      resolveSandboxPath({
        filePath: "/home/node/.openclaw/workspace/mail/trigger.txt",
        cwd: root,
        root,
      }),
    ).toEqual({
      resolved: path.join(root, "workspace", "mail", "trigger.txt"),
      relative: path.join("workspace", "mail", "trigger.txt"),
    });
  });

  it("maps legacy workspace aliases when the sandbox root is nested under .openclaw", () => {
    const root = path.join("/Users", "chris", ".openclaw", "workspace");
    expect(
      resolveSandboxPath({
        filePath: "/home/node/.openclaw/workspace/mail/trigger.txt",
        cwd: root,
        root,
      }),
    ).toEqual({
      resolved: path.join(root, "mail", "trigger.txt"),
      relative: path.join("mail", "trigger.txt"),
    });
  });

  it("still rejects unrelated absolute paths outside the sandbox root", () => {
    const root = path.join("/Users", "chris", ".openclaw");
    expect(() =>
      resolveSandboxPath({
        filePath: "/home/node/secrets.txt",
        cwd: root,
        root,
      }),
    ).toThrow(/escapes sandbox root/i);
  });

  it("does not apply the alias when the sandbox root is not under .openclaw", () => {
    const root = path.join("/Users", "chris", "workspace");
    expect(() =>
      resolveSandboxPath({
        filePath: "/home/node/.openclaw/workspace/mail/trigger.txt",
        cwd: root,
        root,
      }),
    ).toThrow(/escapes sandbox root/i);
  });
});
