---
summary: "マルチエージェント ルーティング：分離されたエージェント、チャンネル アカウント、バインディング"
title: マルチエージェント ルーティング
read_when: "1 つの Gateway プロセスで、分離された複数のエージェント（ワークスペース + 認証）を使いたい場合。"
status: active
x-i18n:
  source_path: concepts/multi-agent.md
  source_hash: aa2b77f4707628ca
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:45Z
---

# マルチエージェント ルーティング

目的：1 つの稼働中の Gateway で、複数の _分離された_ エージェント（個別のワークスペース + `agentDir` + セッション）と、複数のチャンネル アカウント（例：2 つの WhatsApp）を同時に扱います。インバウンドは、バインディングによってエージェントへルーティングされます。

## 「1 つのエージェント」とは？

**エージェント**とは、次をそれぞれ専有する、完全にスコープ化された「頭脳」です。

- **ワークスペース**（ファイル、AGENTS.md / SOUL.md / USER.md、ローカル ノート、ペルソナ ルール）。
- **状態ディレクトリ**（`agentDir`）：認証プロファイル、モデル レジストリ、エージェント別設定。
- **セッション ストア**（チャット履歴 + ルーティング状態）：`~/.openclaw/agents/<agentId>/sessions` 配下。

認証プロファイルは **エージェント単位** です。各エージェントは、次から読み取ります。

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

メイン エージェントの認証情報は自動的に共有 **されません**。エージェント間で `agentDir` を再利用しないでください（認証／セッションの衝突を引き起こします）。認証情報を共有したい場合は、`auth-profiles.json` を別のエージェントの `agentDir` にコピーしてください。

Skills は、各ワークスペースの `skills/` フォルダーを通じて **エージェント単位** で提供され、共有 Skills は `~/.openclaw/skills` から利用できます。詳細は [Skills: per-agent vs shared](/tools/skills#per-agent-vs-shared-skills) を参照してください。

Gateway は **1 つのエージェント**（デフォルト）または **複数のエージェント** を並列にホストできます。

**ワークスペースに関する注意：** 各エージェントのワークスペースは **デフォルトの cwd** であり、厳密なサンドボックスではありません。相対パスはワークスペース内に解決されますが、サンドボックス化が有効でない限り、絶対パスはホスト上の他の場所へ到達できます。詳細は [Sandboxing](/gateway/sandboxing) を参照してください。

## パス（クイック マップ）

- 設定：`~/.openclaw/openclaw.json`（または `OPENCLAW_CONFIG_PATH`）
- 状態ディレクトリ：`~/.openclaw`（または `OPENCLAW_STATE_DIR`）
- ワークスペース：`~/.openclaw/workspace`（または `~/.openclaw/workspace-<agentId>`）
- エージェント ディレクトリ：`~/.openclaw/agents/<agentId>/agent`（または `agents.list[].agentDir`）
- セッション：`~/.openclaw/agents/<agentId>/sessions`

### 単一エージェント モード（デフォルト）

何も設定しない場合、OpenClaw は単一エージェントで実行されます。

- `agentId` は **`main`** がデフォルトです。
- セッションは `agent:main:<mainKey>` としてキー付けされます。
- ワークスペースのデフォルトは `~/.openclaw/workspace`（`OPENCLAW_PROFILE` が設定されている場合は `~/.openclaw/workspace-<profile>`）です。
- 状態のデフォルトは `~/.openclaw/agents/main/agent` です。

## エージェント ヘルパー

エージェント ウィザードを使用して、新しい分離エージェントを追加します。

```bash
openclaw agents add work
```

次に、インバウンド メッセージをルーティングするために `bindings` を追加します（またはウィザードに任せます）。

次で確認します。

```bash
openclaw agents list --bindings
```

## 複数エージェント = 複数人、複数の人格

**複数エージェント** では、各 `agentId` が **完全に分離されたペルソナ** になります。

- **異なる電話番号／アカウント**（チャンネル `accountId` 単位）。
- **異なる人格**（`AGENTS.md` や `SOUL.md` など、エージェント別ワークスペース ファイル）。
- **分離された認証 + セッション**（明示的に有効化しない限り、相互干渉はありません）。

これにより、**複数人** が 1 台の Gateway サーバーを共有しつつ、AI の「頭脳」とデータを分離して保持できます。

## 1 つの WhatsApp 番号、複数人（DM 分割）

**1 つの WhatsApp アカウント** のまま、**異なる WhatsApp DM** を異なるエージェントへルーティングできます。送信者の E.164（例：`+15551234567`）に一致させて `peer.kind: "dm"` を行います。返信は同じ WhatsApp 番号から送信されます（エージェントごとの送信者 ID はありません）。

重要な注意：ダイレクト チャットはエージェントの **メイン セッション キー** に集約されるため、真の分離には **1 人につき 1 エージェント** が必要です。

例：

```json5
{
  agents: {
    list: [
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },
      { id: "mia", workspace: "~/.openclaw/workspace-mia" },
    ],
  },
  bindings: [
    { agentId: "alex", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230001" } } },
    { agentId: "mia", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230002" } } },
  ],
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551230001", "+15551230002"],
    },
  },
}
```

注記：

- DM のアクセス制御は **WhatsApp アカウント単位でグローバル**（ペアリング／許可リスト）であり、エージェント単位ではありません。
- 共有グループについては、グループを 1 つのエージェントにバインドするか、[Broadcast groups](/channels/broadcast-groups) を使用してください。

## ルーティング ルール（メッセージがエージェントを選ぶ仕組み）

バインディングは **決定的** で、**最も具体的な一致が優先** されます。

1. `peer` の一致（正確な DM／グループ／チャンネル ID）
2. `guildId`（Discord）
3. `teamId`（Slack）
4. チャンネルに対する `accountId` の一致
5. チャンネル レベルの一致（`accountId: "*"`）
6. デフォルト エージェントへフォールバック（`agents.list[].default`、それ以外は最初のエントリ、デフォルト：`main`）

## 複数アカウント／電話番号

**複数アカウント** をサポートするチャンネル（例：WhatsApp）では、各ログインを識別するために `accountId` を使用します。各 `accountId` は異なるエージェントへルーティングできるため、1 台のサーバーで複数の電話番号を、セッションを混在させずにホストできます。

## 概念

- `agentId`：1 つの「頭脳」（ワークスペース、エージェント別認証、エージェント別セッション ストア）。
- `accountId`：1 つのチャンネル アカウント インスタンス（例：WhatsApp アカウント `"personal"` と `"biz"`）。
- `binding`：`(channel, accountId, peer)` および必要に応じてギルド／チーム ID により、インバウンド メッセージを `agentId` へルーティングします。
- ダイレクト チャットは `agent:<agentId>:<mainKey>`（エージェント別の「メイン」；`session.mainKey`）に集約されます。

## 例：2 つの WhatsApp → 2 つのエージェント

`~/.openclaw/openclaw.json`（JSON5）：

```js
{
  agents: {
    list: [
      {
        id: "home",
        default: true,
        name: "Home",
        workspace: "~/.openclaw/workspace-home",
        agentDir: "~/.openclaw/agents/home/agent",
      },
      {
        id: "work",
        name: "Work",
        workspace: "~/.openclaw/workspace-work",
        agentDir: "~/.openclaw/agents/work/agent",
      },
    ],
  },

  // Deterministic routing: first match wins (most-specific first).
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // Optional per-peer override (example: send a specific group to work agent).
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // Off by default: agent-to-agent messaging must be explicitly enabled + allowlisted.
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },

  channels: {
    whatsapp: {
      accounts: {
        personal: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## 例：WhatsApp の日常チャット + Telegram の集中作業

チャンネルで分割：WhatsApp は日常向けの高速エージェントへ、Telegram は Opus エージェントへルーティングします。

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "opus", match: { channel: "telegram" } },
  ],
}
```

注記：

- チャンネルに複数アカウントがある場合、バインディングに `accountId` を追加してください（例：`{ channel: "whatsapp", accountId: "personal" }`）。
- 特定の DM／グループのみを Opus にルーティングし、残りはチャットに保つには、そのピアに対して `match.peer` のバインディングを追加します。ピア一致は常にチャンネル全体のルールより優先されます。

## 例：同一チャンネルで、1 つのピアのみを Opus へ

WhatsApp は高速エージェントのままにし、1 つの DM だけを Opus にルーティングします。

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "opus", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551234567" } } },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

ピア バインディングは常に優先されるため、チャンネル全体のルールより上に配置してください。

## WhatsApp グループにバインドされたファミリー エージェント

メンション ゲーティングと、より厳格なツール ポリシーを用いて、専用のファミリー エージェントを 1 つの WhatsApp グループにバインドします。

```json5
{
  agents: {
    list: [
      {
        id: "family",
        name: "Family",
        workspace: "~/.openclaw/workspace-family",
        identity: { name: "Family Bot" },
        groupChat: {
          mentionPatterns: ["@family", "@familybot", "@Family Bot"],
        },
        sandbox: {
          mode: "all",
          scope: "agent",
        },
        tools: {
          allow: [
            "exec",
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "browser", "canvas", "nodes", "cron"],
        },
      },
    ],
  },
  bindings: [
    {
      agentId: "family",
      match: {
        channel: "whatsapp",
        peer: { kind: "group", id: "120363999999999999@g.us" },
      },
    },
  ],
}
```

注記：

- ツールの許可／拒否リストは **Skills ではなくツール** です。Skill がバイナリを実行する必要がある場合は、`exec` が許可されており、かつそのバイナリがサンドボックス内に存在することを確認してください。
- より厳格なゲーティングには、`agents.list[].groupChat.mentionPatterns` を設定し、チャンネルのグループ許可リストを有効に保ってください。

## エージェント別サンドボックスとツール設定

v2026.1.6 以降、各エージェントは独自のサンドボックスおよびツール制限を持てます。

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // No sandbox for personal agent
        },
        // No tool restrictions - all tools available
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // Always sandboxed
          scope: "agent",  // One container per agent
          docker: {
            // Optional one-time setup after container creation
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // Only read tool
          deny: ["exec", "write", "edit", "apply_patch"],    // Deny others
        },
      },
    ],
  },
}
```

注記：`setupCommand` は `sandbox.docker` 配下に存在し、コンテナ作成時に 1 度だけ実行されます。解決されたスコープが `"shared"` の場合、エージェント別の `sandbox.docker.*` オーバーライドは無視されます。

**利点：**

- **セキュリティ分離**：信頼できないエージェントに対するツール制限
- **リソース制御**：特定のエージェントのみをサンドボックス化し、他はホスト上で実行
- **柔軟なポリシー**：エージェントごとに異なる権限

注記：`tools.elevated` は **グローバル** で送信者ベースです。エージェント単位では設定できません。エージェント別の境界が必要な場合は、`agents.list[].tools` を使用して `exec` を拒否してください。グループのターゲティングには、@メンションが意図したエージェントに正しくマッピングされるよう、`agents.list[].groupChat.mentionPatterns` を使用してください。

詳細な例は [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) を参照してください。
