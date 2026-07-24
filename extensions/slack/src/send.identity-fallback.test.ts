// Slack tests cover send.identity fallback plugin behavior.
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSendTestClient } from "./blocks.test-helpers.js";
import { hasSlackThreadParticipation } from "./sent-thread-cache.js";

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  logVerbose: vi.fn(),
  danger: (message: string) => message,
  shouldLogVerbose: () => false,
}));

const { sendMessageSlack, setSlackDefaultSendIdentity } = await import("./send.js");
const { slackPlugin } = await import("./channel.js");
const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };

type SlackMissingScopeError = Error & {
  data?: {
    error?: string;
    needed?: string;
    response_metadata?: { scopes?: string[]; acceptedScopes?: string[] };
  };
};

function buildSlackPlatformError(code: string): SlackMissingScopeError {
  const err = new Error(`An API error occurred: ${code}`) as SlackMissingScopeError;
  err.data = { error: code };
  return err;
}

function buildMissingScopeError(overrides?: {
  needed?: string;
  scopes?: string[];
  acceptedScopes?: string[];
}): SlackMissingScopeError {
  const err = new Error("An API error occurred: missing_scope") as SlackMissingScopeError;
  const response_metadata =
    overrides?.scopes || overrides?.acceptedScopes
      ? {
          ...(overrides?.scopes ? { scopes: overrides.scopes } : {}),
          ...(overrides?.acceptedScopes ? { acceptedScopes: overrides.acceptedScopes } : {}),
        }
      : undefined;
  err.data = {
    error: "missing_scope",
    ...(overrides?.needed != null ? { needed: overrides.needed } : {}),
    ...(response_metadata ? { response_metadata } : {}),
  };
  return err;
}

function buildInvalidIdentityError(): SlackMissingScopeError {
  const err = new Error("An API error occurred: invalid_arguments") as SlackMissingScopeError;
  err.data = { error: "invalid_arguments" };
  return err;
}

function readPostMessagePayload(
  client: ReturnType<typeof createSlackSendTestClient>,
  index: number,
): Record<string, unknown> {
  const call = vi.mocked(client.chat.postMessage).mock.calls[index];
  if (!call) {
    throw new Error(`expected Slack postMessage call #${index + 1}`);
  }
  const [payload] = call;
  if (!payload || typeof payload !== "object") {
    throw new Error(`expected Slack postMessage payload #${index + 1}`);
  }
  return payload as Record<string, unknown>;
}

describe("sendMessageSlack customize-scope fallback", () => {
  beforeEach(() => {
    vi.mocked(logVerbose).mockClear();
    setSlackDefaultSendIdentity("default", undefined);
  });

  it("uses the relay-provided default identity", async () => {
    const client = createSlackSendTestClient();
    vi.mocked(client.chat.postMessage).mockResolvedValueOnce({ ts: "171234.567" });
    setSlackDefaultSendIdentity("default", {
      username: "Nik Team Claw",
      iconUrl: "https://example.com/nik.png",
    });

    await sendMessageSlack("channel:C123", "hello", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });

    expect(readPostMessagePayload(client, 0)).toEqual({
      channel: "C123",
      text: "hello",
      username: "Nik Team Claw",
      icon_url: "https://example.com/nik.png",
      unfurl_links: false,
    });
  });

  it.each([
    { target: "channel:c08gqh53ejm", expected: "C08GQH53EJM" },
    { target: "c08gqh53ejm", expected: "C08GQH53EJM" },
    { target: "user:u09g2dj0275", expected: "U09G2DJ0275" },
    { target: "u09g2dj0275", expected: "U09G2DJ0275" },
    { target: "@u09g2dj0275", expected: "U09G2DJ0275" },
    { target: "user:w09g2dj0275", expected: "W09G2DJ0275" },
    { target: "w09g2dj0275", expected: "W09G2DJ0275" },
    { target: "companychat", expected: "companychat" },
    { target: "channel:companychat", expected: "companychat" },
    { target: "#companychat", expected: "companychat" },
    { target: "#c08gqh53ejm", expected: "c08gqh53ejm" },
    {
      target: "team:T123:channel:C08GQH53EJM",
      expected: "team:T123:channel:C08GQH53EJM",
    },
  ])("resolves API target $target as $expected", async ({ target, expected }) => {
    const client = createSlackSendTestClient();
    vi.mocked(client.chat.postMessage).mockResolvedValueOnce({ ts: "171234.567" });

    await sendMessageSlack(target, "hello", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });

    expect(readPostMessagePayload(client, 0)).toMatchObject({ channel: expected });
  });

  it("opens a DM with the canonical form of a folded bare user id", async () => {
    const client = createSlackSendTestClient();

    await sendMessageSlack("u09g2dj0276", "hello", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      threadTs: "1712345678.123456",
    });

    expect(client.conversations.open).toHaveBeenCalledWith({ users: "U09G2DJ0276" });
  });

  it("restores a folded session target at the final send boundary", async () => {
    const client = createSlackSendTestClient();
    const target = slackPlugin.messaging?.resolveSessionTarget?.({
      kind: "channel",
      id: "c08gqh53ejm",
    });
    expect(target).toBe("channel:c08gqh53ejm");

    await sendMessageSlack(target ?? "", "hello", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });

    expect(readPostMessagePayload(client, 0)).toMatchObject({ channel: "C08GQH53EJM" });
  });

  it.each(["updates", "workspace"])(
    "keeps the channel name %s out of user-ID resolution",
    async (target) => {
      const client = createSlackSendTestClient();

      await sendMessageSlack(target, "hello", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        threadTs: "1712345678.123456",
      });

      expect(client.conversations.open).not.toHaveBeenCalled();
      expect(readPostMessagePayload(client, 0)).toMatchObject({ channel: target });
    },
  );

  it("prefers an explicit send identity over the relay default", async () => {
    const client = createSlackSendTestClient();
    vi.mocked(client.chat.postMessage).mockResolvedValueOnce({ ts: "171234.567" });
    setSlackDefaultSendIdentity("default", { username: "Nik Team Claw" });

    await sendMessageSlack("channel:C123", "hello", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      identity: { username: "Explicit Bot", iconEmoji: ":robot_face:" },
    });

    expect(readPostMessagePayload(client, 0)).toEqual({
      channel: "C123",
      text: "hello",
      username: "Explicit Bot",
      icon_emoji: ":robot_face:",
      unfurl_links: false,
    });
  });

  it("retries without identity when needed contains chat:write.customize", async () => {
    const client = createSlackSendTestClient();
    vi.mocked(client.chat.postMessage)
      .mockRejectedValueOnce(buildMissingScopeError({ needed: "chat:write.customize" }))
      .mockResolvedValueOnce({ ts: "171234.567" });

    const result = await sendMessageSlack("channel:C123", "hello", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      identity: { username: "Bot", iconUrl: "https://example.com/bot.png" },
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    const firstCall = readPostMessagePayload(client, 0);
    const secondCall = readPostMessagePayload(client, 1);
    expect(firstCall).toEqual({
      channel: "C123",
      text: "hello",
      username: "Bot",
      icon_url: "https://example.com/bot.png",
      unfurl_links: false,
    });
    expect(secondCall).toEqual({
      channel: "C123",
      text: "hello",
      unfurl_links: false,
    });
    expect(vi.mocked(logVerbose)).toHaveBeenCalledWith(
      "slack send: custom identity rejected, retrying without custom identity",
    );
    expect(result.messageId).toBe("171234.567");
  });

  it("retries when chat:write.customize appears only in response_metadata.acceptedScopes", async () => {
    const client = createSlackSendTestClient();
    vi.mocked(client.chat.postMessage)
      .mockRejectedValueOnce(
        buildMissingScopeError({ acceptedScopes: ["chat:write", "chat:write.customize"] }),
      )
      .mockResolvedValueOnce({ ts: "171234.567" });

    await sendMessageSlack("channel:C123", "hello", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      identity: { iconEmoji: ":robot_face:" },
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    const secondCall = readPostMessagePayload(client, 1);
    expect(secondCall).not.toHaveProperty("icon_emoji");
    expect(vi.mocked(logVerbose)).toHaveBeenCalledWith(
      "slack send: custom identity rejected, retrying without custom identity",
    );
  });

  it("retries when chat:write.customize appears only in response_metadata.scopes", async () => {
    const client = createSlackSendTestClient();
    vi.mocked(client.chat.postMessage)
      .mockRejectedValueOnce(buildMissingScopeError({ scopes: ["chat:write.customize"] }))
      .mockResolvedValueOnce({ ts: "171234.567" });

    await sendMessageSlack("channel:C123", "hello", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      identity: { username: "Bot" },
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logVerbose)).toHaveBeenCalledWith(
      "slack send: custom identity rejected, retrying without custom identity",
    );
  });

  it("preserves the username when Slack rejects the custom icon", async () => {
    const client = createSlackSendTestClient();
    vi.mocked(client.chat.postMessage)
      .mockRejectedValueOnce(buildInvalidIdentityError())
      .mockResolvedValueOnce({ ts: "171234.567" });

    await sendMessageSlack("channel:C123", "hello", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      identity: { username: "Pulse", iconEmoji: "📟" },
    });

    expect(readPostMessagePayload(client, 0)).toMatchObject({
      username: "Pulse",
      icon_emoji: "📟",
    });
    expect(readPostMessagePayload(client, 1)).toEqual({
      channel: "C123",
      text: "hello",
      username: "Pulse",
      unfurl_links: false,
    });
    expect(vi.mocked(logVerbose)).toHaveBeenCalledWith(
      "slack send: custom icon rejected, retrying with username only",
    );
  });

  it("drops the full identity only when Slack also rejects the username-only retry", async () => {
    const client = createSlackSendTestClient();
    vi.mocked(client.chat.postMessage)
      .mockRejectedValueOnce(buildInvalidIdentityError())
      .mockRejectedValueOnce(buildInvalidIdentityError())
      .mockResolvedValueOnce({ ts: "171234.567" });

    await sendMessageSlack("channel:C123", "hello", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      identity: { username: "Pulse", iconEmoji: "📟" },
    });

    expect(readPostMessagePayload(client, 1)).toMatchObject({ username: "Pulse" });
    expect(readPostMessagePayload(client, 1)).not.toHaveProperty("icon_emoji");
    expect(readPostMessagePayload(client, 2)).toEqual({
      channel: "C123",
      text: "hello",
      unfurl_links: false,
    });
    expect(vi.mocked(logVerbose)).toHaveBeenCalledWith(
      "slack send: custom identity rejected, retrying without custom identity",
    );
  });

  it("reuses the downgraded identity for later chunks", async () => {
    const client = createSlackSendTestClient();
    vi.mocked(client.chat.postMessage)
      .mockRejectedValueOnce(buildInvalidIdentityError())
      .mockResolvedValue({ ts: "171234.567" });

    await sendMessageSlack("channel:C123", "alpha beta", {
      token: "xoxb-test",
      cfg: { channels: { slack: { botToken: "xoxb-test", textChunkLimit: 5 } } },
      client,
      identity: { username: "Pulse", iconEmoji: "📟" },
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(3);
    expect(readPostMessagePayload(client, 0)).toMatchObject({
      username: "Pulse",
      icon_emoji: "📟",
    });
    for (const index of [1, 2]) {
      expect(readPostMessagePayload(client, index)).toMatchObject({ username: "Pulse" });
      expect(readPostMessagePayload(client, index)).not.toHaveProperty("icon_emoji");
    }
  });

  it("rethrows missing_scope errors that reference a different scope", async () => {
    const client = createSlackSendTestClient();
    const err = buildMissingScopeError({ needed: "channels:history" });
    vi.mocked(client.chat.postMessage).mockRejectedValueOnce(err);

    await expect(
      sendMessageSlack("channel:C123", "hello", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        identity: { username: "Bot" },
      }),
    ).rejects.toThrow("An API error occurred: missing_scope (needed: channels:history)");

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logVerbose)).not.toHaveBeenCalled();
  });

  it("rethrows customize-scope errors when identity is empty", async () => {
    const client = createSlackSendTestClient();
    const err = buildMissingScopeError({ needed: "chat:write.customize" });
    vi.mocked(client.chat.postMessage).mockRejectedValueOnce(err);

    await expect(
      sendMessageSlack("channel:C123", "hello", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
      }),
    ).rejects.toThrow("An API error occurred: missing_scope (needed: chat:write.customize)");

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logVerbose)).not.toHaveBeenCalled();
  });

  it("preserves Slack missing-scope details for delivery queue recovery", async () => {
    const client = createSlackSendTestClient();
    vi.mocked(client.chat.postMessage).mockRejectedValueOnce(
      buildMissingScopeError({
        needed: "im:write",
        scopes: ["chat:write", "users:read"],
        acceptedScopes: ["im:write", "mpim:write"],
      }),
    );

    await expect(
      sendMessageSlack("channel:C123", "hello", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
      }),
    ).rejects.toThrow(
      "An API error occurred: missing_scope (needed: im:write; granted: chat:write, users:read; accepted: im:write, mpim:write)",
    );
  });

  it("preserves Slack missing-scope details while opening DMs", async () => {
    const client = createSlackSendTestClient();
    vi.mocked(client.conversations.open).mockRejectedValueOnce(
      buildMissingScopeError({
        needed: "im:write",
        scopes: ["chat:write"],
      }),
    );

    await expect(
      sendMessageSlack("user:U123", "hello", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        threadTs: "171234.100",
      }),
    ).rejects.toThrow(
      "An API error occurred: missing_scope (needed: im:write; granted: chat:write)",
    );
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });
  // Ported progress-chrome guard coverage

  it("converts progress chrome text to a thread reaction instead of chat.postMessage", async () => {
    const client = createSlackSendTestClient();

    const result = await sendMessageSlack("channel:C123", ":hammer_and_wrench: `pnpm test`", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      progressChrome: true,
      threadTs: "171234.000",
    });

    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "171234.000",
      name: "hammer_and_wrench",
    });
    expect(result.messageId).toBe("suppressed");
    expect(result.suppressed).toBe(true);
    expect(result.channelId).toBe("C123");
    expect(hasSlackThreadParticipation("default", "C123", "171234.000")).toBe(false);
  });

  it("converts current unicode progress chrome text to a thread reaction", async () => {
    const client = createSlackSendTestClient();

    const result = await sendMessageSlack("channel:C123", "✍️ Write: to /tmp/demo/index.html", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      progressChrome: true,
      threadTs: "171234.000",
    });

    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "171234.000",
      name: "writing_hand",
    });
    expect(result.messageId).toBe("suppressed");
    expect(result.suppressed).toBe(true);
    expect(result.channelId).toBe("C123");
    expect(hasSlackThreadParticipation("default", "C123", "171234.000")).toBe(false);
  });

  it("converts read progress chrome text to a thread reaction", async () => {
    const client = createSlackSendTestClient();

    const result = await sendMessageSlack("channel:C123", "📖 Read: /tmp/demo/index.html", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      progressChrome: true,
      threadTs: "171234.000",
    });

    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "171234.000",
      name: "open_book",
    });
    expect(result.messageId).toBe("suppressed");
    expect(result.suppressed).toBe(true);
    expect(result.channelId).toBe("C123");
    expect(hasSlackThreadParticipation("default", "C123", "171234.000")).toBe(false);
  });

  it("converts compact command progress chrome text to a thread reaction", async () => {
    const client = createSlackSendTestClient();

    const result = await sendMessageSlack(
      "channel:C123",
      "🛠️ print lines 1-80 from extensions/discord/src/draft-stream.ts",
      {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        progressChrome: true,
        threadTs: "171234.000",
      },
    );

    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "171234.000",
      name: "hammer_and_wrench",
    });
    expect(result.messageId).toBe("suppressed");
    expect(result.suppressed).toBe(true);
    expect(result.channelId).toBe("C123");
    expect(hasSlackThreadParticipation("default", "C123", "171234.000")).toBe(false);
  });

  it("converts status-only command progress chrome text to a thread reaction", async () => {
    const client = createSlackSendTestClient();

    const result = await sendMessageSlack("channel:C123", "🛠️ Exec", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      progressChrome: true,
      threadTs: "171234.000",
    });

    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "171234.000",
      name: "hammer_and_wrench",
    });
    expect(result.messageId).toBe("suppressed");
    expect(result.suppressed).toBe(true);
    expect(result.channelId).toBe("C123");
    expect(hasSlackThreadParticipation("default", "C123", "171234.000")).toBe(false);
  });

  it("converts plain generated exec progress chrome text to a thread reaction", async () => {
    const client = createSlackSendTestClient();

    const result = await sendMessageSlack("channel:C123", "🛠️ Exec: run tests", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      progressChrome: true,
      threadTs: "171234.000",
    });

    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "171234.000",
      name: "hammer_and_wrench",
    });
    expect(result.messageId).toBe("suppressed");
    expect(result.suppressed).toBe(true);
    expect(result.channelId).toBe("C123");
    expect(hasSlackThreadParticipation("default", "C123", "171234.000")).toBe(false);
  });

  it("converts documented exec progress chrome summaries to a thread reaction", async () => {
    const client = createSlackSendTestClient();

    const result = await sendMessageSlack("channel:C123", "🛠️ Exec: checking JS syntax", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      progressChrome: true,
      threadTs: "171234.000",
    });

    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "171234.000",
      name: "hammer_and_wrench",
    });
    expect(result.messageId).toBe("suppressed");
    expect(result.suppressed).toBe(true);
    expect(result.channelId).toBe("C123");
    expect(hasSlackThreadParticipation("default", "C123", "171234.000")).toBe(false);
  });

  it("converts apply-patch progress chrome text to a thread reaction", async () => {
    const client = createSlackSendTestClient();

    const result = await sendMessageSlack(
      "channel:C123",
      "🩹 Apply Patch: /tmp/demo/{index.html, style.css}",
      {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        progressChrome: true,
        threadTs: "171234.000",
      },
    );

    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "171234.000",
      name: "adhesive_bandage",
    });
    expect(result.messageId).toBe("suppressed");
    expect(result.suppressed).toBe(true);
    expect(result.channelId).toBe("C123");
    expect(hasSlackThreadParticipation("default", "C123", "171234.000")).toBe(false);
  });

  it("converts web-search progress chrome text to a thread reaction", async () => {
    const client = createSlackSendTestClient();

    const result = await sendMessageSlack(
      "channel:C123",
      '🔎 Web Search: for "Codex OAuth API key"',
      {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        progressChrome: true,
        threadTs: "171234.000",
      },
    );

    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "171234.000",
      name: "mag",
    });
    expect(result.messageId).toBe("suppressed");
    expect(result.suppressed).toBe(true);
    expect(result.channelId).toBe("C123");
    expect(hasSlackThreadParticipation("default", "C123", "171234.000")).toBe(false);
  });

  it("fails closed on progress chrome text without a reaction target", async () => {
    const client = createSlackSendTestClient();

    const result = await sendMessageSlack("channel:C123", ":writing_hand: Write: MEMORY.md", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      progressChrome: true,
    });

    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(client.reactions.add).not.toHaveBeenCalled();
    expect(result.messageId).toBe("suppressed");
    expect(result.suppressed).toBe(true);
    expect(result.channelId).toBe("C123");
  });

  it("suppresses progress chrome text when the thread reaction fails", async () => {
    const client = createSlackSendTestClient();
    vi.mocked(client.reactions.add).mockRejectedValueOnce(buildSlackPlatformError("missing_scope"));

    const result = await sendMessageSlack("channel:C123", ":hammer_and_wrench: `pnpm test`", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      progressChrome: true,
      threadTs: "171234.000",
    });

    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "171234.000",
      name: "hammer_and_wrench",
    });
    expect(result.messageId).toBe("suppressed");
    expect(result.suppressed).toBe(true);
    expect(result.channelId).toBe("C123");
  });

  it("does not convert semantic Slack replies into progress chrome reactions", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage.mockResolvedValue({
      ok: true,
      ts: "171999.000",
      channel: "C123",
    });

    const semanticMessages = [
      ":hammer_and_wrench: I fixed the deployment issue and verified production.",
      ":email: Message sent to the client.",
      ":email: Message: invoice sent",
      ":hammer_and_wrench: I ran `pnpm test` and it passed.",
      ":hammer_and_wrench: I ran `pnpm test` and it passed",
      "✍️ I wrote the summary and verified production.",
      "🔍 Search: #general",
      "✍️ Write: README.md",
      "📧 Message: @alice",
    ];

    for (const message of semanticMessages) {
      client.chat.postMessage.mockClear();
      client.reactions.add.mockClear();

      const result = await sendMessageSlack("channel:C123", message, {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        threadTs: "171234.000",
      });

      expect(client.reactions.add).not.toHaveBeenCalled();
      expect(client.chat.postMessage).toHaveBeenCalled();
      expect(result.suppressed).not.toBe(true);
      expect(result.messageId).toBe("171999.000");
    }
  });
});
