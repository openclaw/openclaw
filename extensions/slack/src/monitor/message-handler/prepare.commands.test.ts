import { expect, it } from "vitest";
import { prepareSlackMessage } from "./prepare.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
  createSlackTestAccount,
} from "./prepare.test-helpers.js";

const store = createSlackSessionStoreFixture("slack-command-lines-");

it.each([
  ["/btw why?\n  first frame\n\n    second frame", "/btw why?\n  first frame\n\n    second frame"],
  ["/loop 5m check\n  deploy status", "/loop 5m check\n  deploy status"],
  ["/btw   progress?", "/btw progress?"],
])(
  "preserves the argument text of mention-prefixed %j at command admission",
  async (command, expected) => {
    const ctx = createInboundSlackTestContext({
      cfg: {
        session: { store: store.makeTmpStorePath().storePath },
        channels: { slack: { enabled: true } },
      },
    });
    ctx.resolveUserName = async () => ({ name: "Sender" });
    const result = await prepareSlackMessage({
      ctx,
      account: createSlackTestAccount(),
      message: {
        type: "message",
        channel: "D1",
        channel_type: "im",
        user: "U1",
        text: `<@B1> ${command}`,
        ts: "1700000000.0001",
      },
      opts: { source: "message" },
    });
    expect(result?.ctxPayload).toMatchObject({
      CommandBody: expected,
      BodyForCommands: expected,
    });
  },
);
