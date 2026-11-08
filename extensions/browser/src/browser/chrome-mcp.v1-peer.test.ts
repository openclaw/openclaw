import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withChromeMcpLease } from "./chrome-mcp-routing.js";
import { closeChromeMcpSession, getChromeMcpPid } from "./chrome-mcp-session.js";

const peer = fileURLToPath(new URL("./chrome-mcp.v1-peer.fixture.mjs", import.meta.url));

describe("Chrome MCP v1 stdio interoperability", () => {
  let state: OpenClawTestState;
  let profile: string;

  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "chrome-mcp-v1-peer-" });
    profile = state.root;
  });

  afterEach(async () => {
    try {
      await closeChromeMcpSession(profile);
    } finally {
      await state.cleanup();
    }
  });

  const options = (mode = "plain") => ({
    command: process.execPath,
    args: [peer, state.stateDir, mode],
  });
  const events = async (): Promise<
    Array<{ event: string; pid?: number; cursor?: string | null; name?: string }>
  > => JSON.parse(await fs.readFile(state.statePath("events.json"), "utf8"));

  it("keeps the first catalog page and validates its tool outputs", async () => {
    await withChromeMcpLease(profile, options(), {}, async ({ callTool }) => {
      await expect(callTool("fixture.echo", {})).resolves.toMatchObject({
        structuredContent: { value: "first-page-result" },
      });
      await expect(callTool("fixture.echo", { invalid: true })).rejects.toThrow(
        /output|schema|valid/i,
      );
    });
    expect((await events()).filter(({ event }) => event === "list")).toEqual([
      { event: "list", cursor: null },
    ]);
    expect((await events()).filter(({ event }) => event === "call")).toEqual([
      { event: "call", name: "fixture.echo" },
      { event: "call", name: "fixture.echo" },
    ]);
    expect(getChromeMcpPid(profile)).toBeNull();
  });

  it("does not discover navigation tools on a later catalog page", async () => {
    await expect(
      withChromeMcpLease(profile, options("navigation-second"), {}, async () => {
        throw new Error("A page-two navigation tool must not admit an operation");
      }),
    ).rejects.toThrow("did not expose the expected navigation tools");
    expect((await events()).filter(({ event }) => event === "list")).toEqual([
      { event: "list", cursor: null },
    ]);
    expect(getChromeMcpPid(profile)).toBeNull();
  });

  it("closes the real server and its descendant before releasing the profile", async () => {
    await withChromeMcpLease(profile, options("descendant"), {}, async ({ listTargets }) => {
      expect(await listTargets()).toMatchObject([
        { page: { id: 1, url: "https://example.test/" } },
      ]);
    });
    const pids = (await events()).flatMap(({ pid }) => (pid ? [pid] : []));
    expect(pids).toHaveLength(2);
    for (const pid of pids) {
      expect(() => process.kill(pid, 0)).not.toThrow();
    }
    await expect(closeChromeMcpSession(profile)).resolves.toBe(true);
    for (const pid of pids) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    }
    expect(getChromeMcpPid(profile)).toBeNull();
  });
});
