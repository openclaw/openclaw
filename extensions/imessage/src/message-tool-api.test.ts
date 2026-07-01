// Imessage tests cover message tool api plugin behavior.
import { beforeEach, describe, expect, it } from "vitest";
import { describeMessageTool } from "../message-tool-api.js";
import {
  clearCachedIMessagePrivateApiStatus,
  setCachedIMessagePrivateApiStatus,
} from "./private-api-status.js";

describe("iMessage message-tool artifact", () => {
  beforeEach(() => {
    clearCachedIMessagePrivateApiStatus();
  });

  it("exposes lightweight discovery without loading the channel plugin", () => {
    setCachedIMessagePrivateApiStatus("imsg", {
      available: true,
      v2Ready: true,
      selectors: {
        editMessage: true,
        retractMessagePart: true,
      },
      rpcMethods: [],
    });

    const discovery = describeMessageTool({
      cfg: {
        channels: {
          imessage: {
            cliPath: "imsg",
            actions: {
              edit: false,
            },
          },
        },
      } as never,
      currentChannelId: "chat_id:1",
    });

    expect(discovery?.actions).toStrictEqual([
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
    ]);
  });

  it("offers poll but hides poll-vote on imsg builds without the poll.vote rpc", () => {
    // Released imsg carries the pollPayloadMessage selector (poll create) but
    // predates the `poll.vote` command; poll-vote must stay hidden so this
    // plugin can ship ahead of the imsg release.
    setCachedIMessagePrivateApiStatus("imsg", {
      available: true,
      v2Ready: true,
      selectors: { pollPayloadMessage: true },
      rpcMethods: ["send", "poll.send", "messages.poll.send"],
    });

    const discovery = describeMessageTool({
      cfg: { channels: { imessage: { cliPath: "imsg" } } } as never,
      currentChannelId: "chat_id:1",
    });

    expect(discovery?.actions).toContain("poll");
    expect(discovery?.actions).not.toContain("poll-vote");
  });

  it("offers poll-vote once imsg advertises the poll.vote rpc", () => {
    setCachedIMessagePrivateApiStatus("imsg", {
      available: true,
      v2Ready: true,
      selectors: { pollPayloadMessage: true },
      rpcMethods: ["send", "poll.send", "poll.vote", "messages.poll.vote"],
    });

    const discovery = describeMessageTool({
      cfg: { channels: { imessage: { cliPath: "imsg" } } } as never,
      currentChannelId: "chat_id:1",
    });

    expect(discovery?.actions).toContain("poll");
    expect(discovery?.actions).toContain("poll-vote");
  });

  it("hides private actions when cached bridge status is unavailable", () => {
    setCachedIMessagePrivateApiStatus("imsg", {
      available: false,
      v2Ready: false,
      selectors: {},
      rpcMethods: [],
    });

    const discovery = describeMessageTool({
      cfg: {
        channels: {
          imessage: {
            cliPath: "imsg",
          },
        },
      } as never,
      currentChannelId: "chat_id:1",
    });

    expect(discovery?.actions).toStrictEqual([]);
  });
});
