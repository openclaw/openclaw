import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeMessageTool } from "../message-tool-api.js";
import {
  getCachedIMessagePrivateApiStatus,
  setCachedIMessagePrivateApiStatus,
} from "./private-api-status.js";
import { resolveIMessageRemoteHost } from "./remote-host.js";

const unavailable = { available: false, v2Ready: false, selectors: {}, rpcMethods: [] };
const available = { ...unavailable, available: true, v2Ready: true };
const pollSelectors = { pollPayloadMessage: true, pollVoteMessage: true };
function cacheStatus(overrides: Partial<Parameters<typeof setCachedIMessagePrivateApiStatus>[1]>) {
  setCachedIMessagePrivateApiStatus("imsg", { ...available, ...overrides });
}
function discover(options: Partial<Parameters<typeof describeMessageTool>[0]> = {}) {
  return describeMessageTool({
    cfg: { channels: { imessage: { cliPath: "imsg" } } },
    currentChannelId: "chat_id:1",
    ...options,
  });
}

describe("iMessage message-tool artifact", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    setCachedIMessagePrivateApiStatus("imsg", unavailable, 1);
    getCachedIMessagePrivateApiStatus("imsg");
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })),
    );
  });

  it("uses an already-cached legacy wrapper host for synchronous poll guidance", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-tool-host-"));
    tempDirs.push(dir);
    const cliPath = path.join(dir, "imsg-ssh");
    await fs.writeFile(cliPath, '#!/bin/sh\nexec ssh bot@messages-mac imsg "$@"\n');
    await resolveIMessageRemoteHost({ cliPath });

    const discovery = describeMessageTool({
      cfg: { channels: { imessage: { cliPath } } } as never,
      currentChannelId: "chat_id:1",
    });

    expect(discovery?.schema?.properties).toMatchObject({
      pollOptionId: { description: expect.stringContaining("Required for Remote Mac") },
      pollOptionIndex: { description: expect.stringContaining("Local iMessage accounts only") },
    });
  });

  it.each([
    {
      chatType: "group",
      expectedActions: [
        "react",
        "unsend",
        "reply",
        "sendWithEffect",
        "renameGroup",
        "setGroupIcon",
        "addParticipant",
        "removeParticipant",
        "leaveGroup",
        "upload-file",
      ],
    },
    {
      chatType: "direct",
      expectedActions: ["react", "unsend", "reply", "sendWithEffect", "upload-file"],
    },
  ] as const)(
    "discovers supported actions for a $chatType numeric current chat",
    ({ chatType, expectedActions }) => {
      cacheStatus({ selectors: { editMessage: true, retractMessagePart: true } });

      expect(
        discover({
          chatType,
          cfg: { channels: { imessage: { cliPath: "imsg", actions: { edit: false } } } },
        })?.actions,
      ).toStrictEqual(expectedActions);
    },
  );

  it.each([
    { rpcMethods: [], supported: false },
    { rpcMethods: ["send", "poll.send", "poll.vote", "messages.poll.vote"], supported: true },
  ])("gates poll-vote on RPC support $supported", ({ rpcMethods, supported }) => {
    cacheStatus({ selectors: pollSelectors, rpcMethods });
    const discovery = discover();
    expect(discovery?.actions).toContain("poll");
    expect(discovery?.actions.includes("poll-vote")).toBe(supported);
    if (!supported) {
      expect(discovery?.schema).toBeUndefined();
    }
  });

  it("hides private actions when cached bridge status is unavailable", () => {
    setCachedIMessagePrivateApiStatus("imsg", unavailable);
    expect(discover()?.actions).toStrictEqual([]);
  });
});
