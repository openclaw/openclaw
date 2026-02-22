import { describe, expect, it } from "vitest";
import {
  buildDeleteChatItemCommand,
  buildReceiveFileCommand,
  buildSendMessagesCommand,
  buildUpdateGroupProfileCommand,
  formatChatRef,
} from "./simplex-commands.js";

describe("simplex commands", () => {
  it("rejects unsafe chat refs in send command", () => {
    expect(() =>
      buildSendMessagesCommand({
        chatRef: "@123 ttl=on",
        composedMessages: [],
      }),
    ).toThrow("invalid SimpleX chat ref");
  });

  it("rejects unsafe chat item ids in delete command", () => {
    expect(() =>
      buildDeleteChatItemCommand({
        chatRef: "@123",
        chatItemIds: ["1,2"],
      }),
    ).toThrow("invalid SimpleX chat item id");
  });

  it("quotes file paths for receive command", () => {
    expect(
      buildReceiveFileCommand({
        fileId: 7,
        filePath: "/tmp/My File's Name.png",
      }),
    ).toBe("/freceive 7 '/tmp/My File\\'s Name.png'");
  });

  it("emits raw JSON payload in send command", () => {
    expect(
      buildSendMessagesCommand({
        chatRef: "@123",
        composedMessages: [
          {
            msgContent: {
              type: "text",
              text: "hello world",
            },
          },
        ],
      }),
    ).toBe('/_send @123 json [{"msgContent":{"type":"text","text":"hello world"}}]');
  });

  it("emits raw JSON payload in update group profile command", () => {
    expect(
      buildUpdateGroupProfileCommand({
        groupId: "my-group",
        profile: { displayName: "Team Room" },
      }),
    ).toBe('/_group_profile #my-group {"displayName":"Team Room"}');
  });

  it("rejects unsupported local/scoped chat refs", () => {
    expect(() => formatChatRef({ type: "local", id: "abc" })).toThrow(
      "local SimpleX chat refs are not supported",
    );
    expect(() => formatChatRef({ type: "direct", id: "abc", scope: "team" })).toThrow(
      "scoped SimpleX chat refs are not supported",
    );
  });
});
