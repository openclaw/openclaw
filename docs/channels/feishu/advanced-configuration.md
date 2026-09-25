---
summary: "Feishu multi-account setup, message limits, streaming, workspace tools, ACP sessions, and multi-agent routing"
read_when:
  - Running more than one Feishu bot from one Gateway
  - Tuning streaming card replies or message chunking
  - Enabling the Feishu doc, wiki, drive, or Bitable tools
  - Routing Feishu DMs or groups to different agents
title: "Feishu advanced configuration"
sidebarTitle: "Advanced configuration"
---

Everything under the original Advanced configuration heading: multiple accounts, delivery limits, streaming cards, quota flags, group session scope, workspace tools, ACP sessions, and multi-agent routing.

## Advanced configuration

### Multiple accounts

```json5
{
  channels: {
    feishu: {
      defaultAccount: "main",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          name: "Primary bot",
          tts: {
            providers: {
              openai: { voice: "shimmer" },
            },
          },
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          name: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

`defaultAccount` controls which account is used when outbound APIs do not specify an `accountId`. Account entries inherit top-level settings; most top-level keys can be overridden per account.
`accounts.<id>.tts` uses the same shape as `tts` and deep-merges over global TTS config, so multi-bot Feishu setups can keep shared provider credentials globally while overriding only voice, model, persona, or auto mode per account.

### Message limits

- `textChunkLimit` - outbound text chunk size (default: `4000` chars)
- `streaming.chunkMode` - `"length"` (default) splits at the limit; `"newline"` prefers newline boundaries
- `mediaMaxMb` - media upload/download limit (default: `30` MB)

Ordinary Markdown cards and rich-text posts are also split to fit Feishu's 30 KB
serialized message limit. Headers, notes, mentions, JSON escaping, and UTF-8 text
count toward that limit, so chunks may be shorter than `textChunkLimit`. Long
media captions are sent as text/card chunks before the attachment.

### Streaming

Feishu/Lark supports streaming replies via interactive cards (Card Kit streaming API). When enabled, the bot updates the card in real time as it generates text.

```json5
{
  channels: {
    feishu: {
      streaming: {
        mode: "partial", // streaming card output (default: "partial")
        block: { enabled: true }, // opt into completed-block streaming
      },
    },
  },
}
```

Set `streaming.mode: "off"` to send the completed reply without streaming updates; long replies still split at the message limits above. `renderMode: "raw"` (plain text instead of cards) also disables streaming cards. `streaming.block.enabled` is off by default; enable it only when you want completed assistant blocks flushed before the final reply. Legacy boolean `streaming` and the flat `blockStreaming` / `blockStreamingCoalesce` / `chunkMode` keys migrate to this nested shape via `openclaw doctor --fix`.

Replies with controls use native cards for command buttons and HTTP(S) links, including when streaming is off. The card carries the reply text; attachments remain separate messages. Unsupported controls and cards that exceed Feishu's size limits keep their full labels in a readable fallback. That fallback remains a separate message when a later reply streams. A final controls reply replaces an active streaming preview without sending the preview text again; error controls after a completed answer remain separate. If Feishu cannot delete or clear a replaced preview, delivery reports a failure and retains the original message receipt.

### Quota optimization

Reduce the number of Feishu/Lark API calls with two optional flags:

- `typingIndicator` (default `true`): set `false` to skip typing reaction calls
- `resolveSenderNames` (default `true`): set `false` to skip sender profile lookups

```json5
{
  channels: {
    feishu: {
      typingIndicator: false,
      resolveSenderNames: false,
    },
  },
}
```

### Group session scope and topic threads

`channels.feishu.groupSessionScope` (top-level, per account, or per group) controls how group messages map to agent sessions:

| Value                  | Session                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `"group"` (default)    | One session per group chat                                       |
| `"group_sender"`       | One session per (group + sender)                                 |
| `"group_topic"`        | One session per topic thread; falls back to the group session    |
| `"group_topic_sender"` | One session per (topic + sender); falls back to (group + sender) |

For the topic scopes, native Feishu/Lark topic groups use the event `thread_id` (`omt_*`) as the canonical topic session key. If a native topic starter event omits `thread_id`, OpenClaw hydrates it from Feishu before routing the turn. Normal group replies that OpenClaw turns into threads keep using the reply root message ID (`om_*`) so the first turn and follow-up turns stay in the same session.

Set `replyInThread: "enabled"` (top-level or per group) to make bot replies create or continue a Feishu topic thread instead of replying inline. `topicSessionMode` is the deprecated predecessor of `groupSessionScope`; prefer `groupSessionScope`.

### Feishu workspace tools

The plugin ships agent tools for Feishu documents, chats, knowledge base, cloud storage, permissions, and Bitable, plus matching skills (`feishu-doc`, `feishu-drive`, `feishu-perm`, `feishu-wiki`). Tool families are gated by `channels.feishu.tools`:

| Key             | Tools                                         | Default             |
| --------------- | --------------------------------------------- | ------------------- |
| `tools.doc`     | `feishu_doc` document operations              | `true`              |
| `tools.chat`    | `feishu_chat` chat info + member queries      | `true`              |
| `tools.wiki`    | `feishu_wiki` knowledge base (requires `doc`) | `true`              |
| `tools.drive`   | `feishu_drive` cloud storage                  | `true`              |
| `tools.perm`    | `feishu_perm` permission management           | `false` (sensitive) |
| `tools.scopes`  | `feishu_app_scopes` app scope diagnostics     | `true`              |
| `tools.bitable` | `feishu_bitable_*` Bitable/Base operations    | `true`              |

Per-account gates live under `accounts.<id>.tools`.

After a configuration update is applied, new agent turns use the updated tool
gates and account selection without restarting the Gateway. Tools already created
for an in-progress turn keep their original configuration.

Bitable operations use the application token from a `/base/` URL or returned
`app_token`, not the node token in a `/wiki/` URL. If application creation succeeds
but table metadata is not retrieved, keep the returned `app_token` and URL. Inspect
that existing application rather than creating another one; a missing `table_id`
does not mean creation failed.

`feishu_doc` creates title-only documents. To add Markdown, pass the returned
`document_id` as `doc_token` in a separate `write` action. A `create` request
that includes `content` fails without creating an empty document.

Grant `drive:drive.metadata:readonly` for direct `feishu_drive info` lookups outside the root
directory, unless the app already has the full `drive:drive` scope. Without either scope, `info`
keeps the legacy root-directory lookup available through `drive:drive:readonly`.

### ACP sessions

Feishu/Lark supports ACP for DMs and group thread messages. Feishu/Lark ACP is text-command driven - there are no native slash-command menus, so use `/acp ...` messages directly in the conversation.

#### Persistent ACP binding

```json5
{
  agents: {
    entries: {
      codex: {
        default: true,
        runtime: {
          type: "acp",
          acp: {
            agent: "codex",
            backend: "acpx",
            mode: "persistent",
            cwd: "/workspace/openclaw",
          },
        },
      },
    },
  },
  bindings: [
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "feishu",
        accountId: "default",
        peer: { kind: "direct", id: "ou_1234567890" },
      },
    },
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "feishu",
        accountId: "default",
        peer: { kind: "group", id: "oc_group_chat:topic:om_topic_root" },
      },
      acp: { label: "codex-feishu-topic" },
    },
  ],
}
```

#### Spawn ACP from chat

In a Feishu/Lark DM or thread:

```text
/acp spawn codex --thread here
```

`--thread here` works for DMs and Feishu/Lark thread messages. Follow-up messages in the bound conversation route directly to that ACP session.

### Multi-agent routing

Use `bindings` to route Feishu/Lark DMs or groups to different agents.

```json5
{
  agents: {
    entries: {
      main: { default: true },
      "agent-a": { workspace: "/home/user/agent-a" },
      "agent-b": { workspace: "/home/user/agent-b" },
    },
  },
  bindings: [
    {
      agentId: "agent-a",
      match: {
        channel: "feishu",
        peer: { kind: "direct", id: "ou_xxx" },
      },
    },
    {
      agentId: "agent-b",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

Routing fields:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"direct"` (DM) or `"group"` (group chat)
- `match.peer.id`: user Open ID (`ou_xxx`) or group ID (`oc_xxx`)

See [Get group/user IDs](/channels/feishu/access-control#get-groupuser-ids) for lookup tips.
