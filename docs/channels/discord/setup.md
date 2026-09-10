---
summary: "Create the Discord application, invite the bot, and set up a guild workspace"
read_when:
  - Setting up a Discord bot for OpenClaw for the first time
  - Adding a Discord server to the guild allowlist
title: "Discord setup"
sidebarTitle: "Setup"
---

Everything needed to get a Discord bot running: create the application, grant intents, invite it to a server, pair it, and prepare a guild workspace.

## Quick setup

Create a Discord application with a bot, add the bot to your server, and pair it with OpenClaw. Use a private server if you can; [create one first](https://support.discord.com/hc/en-us/articles/204849977-How-do-I-create-a-server) (**Create My Own > For me and my friends**) if needed.

<Steps>
  <Step title="Create a Discord application and bot">
    In the [Discord Developer Portal](https://discord.com/developers/applications), click **New Application** and name it (for example "OpenClaw").

    Open **Bot** in the sidebar and set the **Username** to your agent's name.

  </Step>

  <Step title="Enable privileged intents">
    Still on the **Bot** page, under **Privileged Gateway Intents** enable:

    - **Message Content Intent** (required for normal guild messages)
    - **Server Members Intent** (recommended; required for role allowlists, name-to-ID matching, and channel-audience access groups)
    - **Presence Intent** (optional; only for presence updates)

  </Step>

  <Step title="Copy your bot token">
    On the **Bot** page, click **Reset Token** and copy the token.

    <Note>
    Despite the name, this generates your first token — nothing is being "reset."
    </Note>

  </Step>

  <Step title="Generate an invite URL and add the bot to your server">
    Open **OAuth2** in the sidebar. In the **OAuth2 URL Generator**, enable the scopes:

    - `bot`
    - `applications.commands`

    In the **Bot Permissions** section that appears, enable at least:

    **General Permissions**
      - View Channels

    **Text Permissions**
      - Send Messages
      - Read Message History
      - Embed Links
      - Attach Files
      - Add Reactions (optional)

    That is the baseline for normal text channels. If the bot will post in threads — including forum or media channel workflows that create or continue a thread — also enable **Send Messages in Threads**.

    Copy the generated URL, open it in a browser, select your server, and click **Continue**. The bot should now appear in your server.

  </Step>

  <Step title="Enable Developer Mode and collect your IDs">
    In the Discord app, enable Developer Mode so you can copy IDs:

    1. **User Settings** (gear icon) → **Developer** → toggle on **Developer Mode**
       *(on mobile: **App Settings** → **Advanced**)*
    2. Right-click your **server icon** → **Copy Server ID**
    3. Right-click your **own avatar** → **Copy User ID**

    Keep the Server ID and User ID with your bot token; you need all three next.

  </Step>

  <Step title="Allow DMs from server members">
    For pairing to work, Discord must let the bot DM you. Right-click your **server icon** → **Privacy Settings** → toggle on **Direct Messages**.

    Keep this on if you use Discord DMs with OpenClaw. If you only use guild channels, you can disable it after pairing.

  </Step>

  <Step title="Set your bot token securely (do not send it in chat)">
    The bot token is a secret. Set it on the machine running OpenClaw before messaging your agent:

```bash
export DISCORD_BOT_TOKEN="YOUR_BOT_TOKEN"
cat > discord.patch.json5 <<'JSON5'
{
  channels: {
    discord: {
      enabled: true,
      token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
    },
  },
}
JSON5
openclaw config patch --file ./discord.patch.json5 --dry-run
openclaw config patch --file ./discord.patch.json5
openclaw gateway
```

    If OpenClaw already runs as a background service, restart it via the OpenClaw Mac app or by stopping and restarting the `openclaw gateway run` process.
    For managed service installs, run `openclaw gateway install` from a shell where `DISCORD_BOT_TOKEN` is set, or store the variable in `~/.openclaw/.env` so the service can resolve the env SecretRef after restart.
    If your host is blocked or rate-limited by Discord's startup application lookup, set the application/client ID from the Developer Portal so startup can skip that REST call: `channels.discord.applicationId` for the default account, or `channels.discord.accounts.<accountId>.applicationId` per bot.

  </Step>

  <Step title="Configure OpenClaw and pair">

    <Tabs>
      <Tab title="Ask your agent">
        Chat with your OpenClaw agent on an existing channel (for example Telegram) and tell it. If Discord is your first channel, use the CLI / config tab instead.

        > "I already set my Discord bot token in config. Please finish Discord setup with User ID `<user_id>` and Server ID `<server_id>`."
      </Tab>
      <Tab title="CLI / config">
        File-based config:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: {
        source: "env",
        provider: "default",
        id: "DISCORD_BOT_TOKEN",
      },
    },
  },
}
```

        Env fallback for the default account:

```bash
DISCORD_BOT_TOKEN=...
```

        For scripted or remote setup, write the same JSON5 block with `openclaw config patch --file ./discord.patch.json5 --dry-run`, then rerun without `--dry-run`. Plaintext `token` strings work too, and SecretRef values are supported for `channels.discord.token` across env/file/exec/store providers. See [Secrets Management](/gateway/secrets).

        For multiple Discord bots, keep each bot token and application ID under its account. A top-level `channels.discord.applicationId` is inherited by accounts, so only set it there when every account uses the same application ID.

```json5
{
  channels: {
    discord: {
      enabled: true,
      accounts: {
        personal: {
          token: { source: "env", provider: "default", id: "DISCORD_PERSONAL_TOKEN" },
          applicationId: "111111111111111111",
        },
        work: {
          token: { source: "env", provider: "default", id: "DISCORD_WORK_TOKEN" },
          applicationId: "222222222222222222",
        },
      },
    },
  },
}
```

      </Tab>
    </Tabs>

  </Step>

  <Step title="Approve first DM pairing">
    Once the gateway is running, DM your bot in Discord. It replies with a pairing code.

    <Tabs>
      <Tab title="Ask your agent">
        Send the pairing code to your agent on your existing channel:

        > "Approve this Discord pairing code: `<CODE>`"
      </Tab>
      <Tab title="CLI">

```bash
openclaw pairing list discord
openclaw pairing approve discord <CODE>
```

      </Tab>
    </Tabs>

    Pairing codes expire after 1 hour. After approval, chat with your agent in a Discord DM.

  </Step>
</Steps>

If Discord cannot grant Message Content Intent, OpenClaw can still operate in DMs and in
guild channels where users explicitly mention the bot. Set
`channels.discord.intents.messageContent: false` so the Gateway does not request the
unavailable privileged intent, and keep `requireMention: true` on every configured guild
channel. Discord omits user-authored content from other guild messages in this mode.

<Note>
Token resolution is account-aware. Config token values win over the env fallback, and `DISCORD_BOT_TOKEN` is only used for the default account.
If two enabled Discord accounts resolve to the same bot token, OpenClaw starts only one gateway monitor for that token: a config-sourced token wins over the env fallback; otherwise the first enabled account wins and the duplicate account is reported disabled with reason `duplicate bot token`.
For advanced outbound calls (message tool/channel actions), an explicit per-call `token` is used for that call. This applies to send and read/probe-style actions (read/search/fetch/thread/pins/permissions). Account policy/retry settings still come from the selected account in the active runtime snapshot.
</Note>

## Recommended: Set up a guild workspace

Once DMs work, you can turn your server into a full workspace where each channel gets its own agent session with its own context. Recommended for private servers where it is just you and your bot.

<Steps>
  <Step title="Add your server to the guild allowlist">
    This lets your agent respond in any channel on your server, not just DMs.

    <Tabs>
      <Tab title="Ask your agent">
        > "Add my Discord Server ID `<server_id>` to the guild allowlist"
      </Tab>
      <Tab title="Config">

```json5
{
  channels: {
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        YOUR_SERVER_ID: {
          requireMention: true,
          users: ["YOUR_USER_ID"],
        },
      },
    },
  },
}
```

      </Tab>
    </Tabs>

  </Step>

  <Step title="Allow responses without @mention">
    By default, the agent only responds in guild channels when @mentioned. On a private server you probably want it to respond to every message.

    In guild channels, normal replies post automatically by default. For shared always-on rooms, opt into `messages.groupChat.visibleReplies: "message_tool"` so the agent can lurk and only post when it decides a channel reply is useful. This works best with latest-generation, tool-reliable models such as GPT-5.6 Sol. Ambient room events stay quiet unless the tool sends. See [Ambient room events](/channels/ambient-room-events) for the full lurk-mode config.

    If Discord shows typing and the logs show token usage but no posted message, check whether the turn was configured as an ambient room event or opted into message-tool visible replies.

    Session-busy notices also respect this reply policy. For ambient events and message-tool replies, Discord records the failure and suppressed notice in Gateway logs without posting to the room.

    <Tabs>
      <Tab title="Ask your agent">
        > "Allow my agent to respond on this server without having to be @mentioned"
      </Tab>
      <Tab title="Config">
        Set `requireMention: false` in your guild config:

```json5
{
  channels: {
    discord: {
      guilds: {
        YOUR_SERVER_ID: {
          requireMention: false,
        },
      },
    },
  },
}
```

        To require message-tool sends for visible group/channel replies, set `messages.groupChat.visibleReplies: "message_tool"`.

      </Tab>
    </Tabs>

  </Step>

  <Step title="Plan for memory in guild channels">
    Long-term memory (MEMORY.md) only auto-loads in DM sessions; guild channels do not load it.

    <Tabs>
      <Tab title="Ask your agent">
        > "When I ask questions in Discord channels, use memory_search or memory_get if you need long-term context from MEMORY.md."
      </Tab>
      <Tab title="Manual">
        For shared context in every channel, put stable instructions in `AGENTS.md` or `USER.md` (injected for every session). Keep long-term notes in `MEMORY.md` and access them on demand with memory tools.
      </Tab>
    </Tabs>

  </Step>
</Steps>

Now create channels and start chatting. The agent sees the channel name, and each channel is an isolated session — set up `#coding`, `#home`, `#research`, or whatever fits your workflow.
