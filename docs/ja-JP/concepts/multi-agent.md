---
summary: "マルチエージェントルーティング: 分離されたエージェント、チャンネルアカウント、およびバインディング"
title: マルチエージェントルーティング
read_when: "1 つの Gateway プロセス内で複数の分離されたエージェント（ワークスペースと認証）を使いたいとき"
status: active
---

# マルチエージェントルーティング

目標: 1 つの稼働中の Gateway 内で複数の_分離された_エージェント（個別のワークスペース + `agentDir` + セッション）と、複数のチャンネルアカウント（例: 2 つの WhatsApp）を運用することです。受信メッセージはバインディングを介してエージェントにルーティングされます。

## 「1 つのエージェント」とは

**エージェント**とは、以下を持つ完全にスコープされたブレインです。

- **ワークスペース**（ファイル、AGENTS.md/SOUL.md/USER.md、ローカルメモ、ペルソナルール）。
- **ステートディレクトリ**（`agentDir`）: 認証プロフィール、モデルレジストリ、エージェントごとの設定。
- **セッションストア**（チャット履歴 + ルーティングステート）: `~/.openclaw/agents/<agentId>/sessions` 以下。

認証プロフィールは**エージェントごと**です。各エージェントは自身の以下のファイルを読み込みます。

```text
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

メインエージェントの認証情報は自動的に共有されません。エージェント間で `agentDir` を再利用しないでください（認証/セッションの衝突が発生します）。認証情報を共有したい場合は、`auth-profiles.json` を別のエージェントの `agentDir` にコピーしてください。

スキルはワークスペースの `skills/` フォルダーを介してエージェントごとに設定され、`~/.openclaw/skills` から共有スキルも利用できます。詳細は[スキル: エージェントごとと共有](/tools/skills#per-agent-vs-shared-skills)を参照してください。

Gateway は**1 つのエージェント**（デフォルト）または**複数のエージェント**を並行してホストできます。

**ワークスペースに関する注意:** 各エージェントのワークスペースは**デフォルトの cwd** であり、ハードなサンドボックスではありません。相対パスはワークスペース内で解決されますが、サンドボックスが有効でない限り、絶対パスはホストの他の場所にアクセスできます。[サンドボックス](/gateway/sandboxing)を参照してください。

## パス（クイックマップ）

- 設定: `~/.openclaw/openclaw.json`（または `OPENCLAW_CONFIG_PATH`）
- ステートディレクトリ: `~/.openclaw`（または `OPENCLAW_STATE_DIR`）
- ワークスペース: `~/.openclaw/workspace`（または `~/.openclaw/workspace-<agentId>`）
- エージェントディレクトリ: `~/.openclaw/agents/<agentId>/agent`（または `agents.list[].agentDir`）
- セッション: `~/.openclaw/agents/<agentId>/sessions`

### シングルエージェントモード（デフォルト）

何も設定しない場合、OpenClaw は 1 つのエージェントで動作します。

- `agentId` はデフォルトで **`main`**。
- セッションは `agent:main:<mainKey>` としてキー付けされます。
- ワークスペースはデフォルトで `~/.openclaw/workspace`（`OPENCLAW_PROFILE` が設定されている場合は `~/.openclaw/workspace-<profile>`）。
- ステートはデフォルトで `~/.openclaw/agents/main/agent`。

## エージェントヘルパー

エージェントウィザードを使って新しい分離されたエージェントを追加します。

```bash
openclaw agents add work
```

次に `bindings` を追加（またはウィザードに任せる）して受信メッセージをルーティングします。

以下で確認します。

```bash
openclaw agents list --bindings
```

## クイックスタート

<Steps>
  <Step title="各エージェントのワークスペースを作成する">

ウィザードを使うか、手動でワークスペースを作成します。

```bash
openclaw agents add coding
openclaw agents add social
```

各エージェントには `SOUL.md`、`AGENTS.md`、オプションの `USER.md` を持つ独自のワークスペースと、`~/.openclaw/agents/<agentId>` 以下の専用 `agentDir` およびセッションストアが割り当てられます。

  </Step>

  <Step title="チャンネルアカウントを作成する">

好みのチャンネルでエージェントごとに 1 つのアカウントを作成します。

- Discord: エージェントごとに 1 つのボット、Message Content Intent を有効にして各トークンをコピーします。
- Telegram: BotFather でエージェントごとに 1 つのボットを作成し、各トークンをコピーします。
- WhatsApp: アカウントごとに各電話番号をリンクします。

```bash
openclaw channels login --channel whatsapp --account work
```

チャンネルガイドを参照してください: [Discord](/channels/discord)、[Telegram](/channels/telegram)、[WhatsApp](/channels/whatsapp)。

  </Step>

  <Step title="エージェント、アカウント、バインディングを追加する">

`agents.list` にエージェントを、`channels.<channel>.accounts` にチャンネルアカウントを追加し、`bindings` でそれらを接続します（以下の例を参照）。

  </Step>

  <Step title="再起動して確認する">

```bash
openclaw gateway restart
openclaw agents list --bindings
openclaw channels status --probe
```

  </Step>
</Steps>

## 複数のエージェント = 複数の人、複数のパーソナリティ

**複数のエージェント**を使用すると、各 `agentId` が**完全に分離されたペルソナ**になります。

- **異なる電話番号/アカウント**（チャンネルの `accountId` ごと）。
- **異なるパーソナリティ**（エージェントごとの `AGENTS.md` や `SOUL.md` などのワークスペースファイル）。
- **個別の認証とセッション**（明示的に有効にしない限りクロストークなし）。

これにより、**複数の人が**一つの Gateway サーバーを共有しながら、自分の AI 「ブレイン」とデータを分離して保持できます。

## WhatsApp 番号 1 つ、複数の人（DM の分割）

**1 つの WhatsApp アカウント**を維持しながら、**異なる WhatsApp DM**を異なるエージェントにルーティングできます。`peer.kind: "direct"` と E.164 形式の送信者（例: `+15551234567`）でマッチングします。返信は同じ WhatsApp 番号から送信されます（エージェントごとの送信者 ID はありません）。

重要な注意点: ダイレクトチャットはエージェントの**メインセッションキー**に収束するため、真の分離には**1 人 1 エージェント**が必要です。

例:

```json5
{
  agents: {
    list: [
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },
      { id: "mia", workspace: "~/.openclaw/workspace-mia" },
    ],
  },
  bindings: [
    {
      agentId: "alex",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551230001" } },
    },
    {
      agentId: "mia",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551230002" } },
    },
  ],
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551230001", "+15551230002"],
    },
  },
}
```

注意:

- DM のアクセス制御はエージェントごとではなく、**WhatsApp アカウント全体**（ペアリング/アローリスト）で設定されます。
- 共有グループの場合は、グループを 1 つのエージェントにバインドするか、[ブロードキャストグループ](/channels/broadcast-groups)を使用してください。

## ルーティングルール（メッセージがエージェントを選択する方法）

バインディングは**決定論的**で、**最も詳細なものが優先**されます。

1. `peer` マッチ（正確な DM/グループ/チャンネル ID）
2. `parentPeer` マッチ（スレッド継承）
3. `guildId + roles`（Discord のロールルーティング）
4. `guildId`（Discord）
5. `teamId`（Slack）
6. チャンネルの `accountId` マッチ
7. チャンネルレベルのマッチ（`accountId: "*"`）
8. デフォルトエージェントへのフォールバック（`agents.list[].default`、なければ最初のリストエントリ、デフォルト: `main`）

同じ階層で複数のバインディングがマッチする場合は、設定の順序で最初のものが優先されます。バインディングに複数のマッチフィールドが設定されている場合（例: `peer` + `guildId`）、指定されたすべてのフィールドが必要です（AND セマンティクス）。

重要なアカウントスコープの詳細:

- `accountId` を省略したバインディングはデフォルトアカウントにのみマッチします。
- チャンネル全体のフォールバックにはすべてのアカウントに対して `accountId: "*"` を使用します。
- 後で同じエージェントに対して明示的なアカウント ID で同じバインディングを追加すると、OpenClaw は重複させるのではなく既存のチャンネルのみのバインディングをアカウントスコープにアップグレードします。

## 複数のアカウント/電話番号

**複数のアカウント**をサポートするチャンネル（例: WhatsApp）では `accountId` を使用して各ログインを識別します。各 `accountId` は異なるエージェントにルーティングできるため、1 つのサーバーでセッションを混在させずに複数の電話番号をホストできます。

## 概念

- `agentId`: 1 つの「ブレイン」（ワークスペース、エージェントごとの認証、エージェントごとのセッションストア）。
- `accountId`: 1 つのチャンネルアカウントインスタンス（例: WhatsApp アカウント `"personal"` vs `"biz"`）。
- `binding`: `(channel, accountId, peer)` と任意の guild/team ID によって受信メッセージを `agentId` にルーティングします。
- ダイレクトチャットは `agent:<agentId>:<mainKey>` に収束します（エージェントごとの「メイン」; `session.mainKey`）。

## プラットフォームの例

### エージェントごとの Discord ボット

各 Discord ボットアカウントは一意の `accountId` にマッピングされます。各アカウントをエージェントにバインドし、ボットごとにアローリストを保持します。

```json5
{
  agents: {
    list: [
      { id: "main", workspace: "~/.openclaw/workspace-main" },
      { id: "coding", workspace: "~/.openclaw/workspace-coding" },
    ],
  },
  bindings: [
    { agentId: "main", match: { channel: "discord", accountId: "default" } },
    { agentId: "coding", match: { channel: "discord", accountId: "coding" } },
  ],
  channels: {
    discord: {
      groupPolicy: "allowlist",
      accounts: {
        default: {
          token: "DISCORD_BOT_TOKEN_MAIN",
          guilds: {
            "123456789012345678": {
              channels: {
                "222222222222222222": { allow: true, requireMention: false },
              },
            },
          },
        },
        coding: {
          token: "DISCORD_BOT_TOKEN_CODING",
          guilds: {
            "123456789012345678": {
              channels: {
                "333333333333333333": { allow: true, requireMention: false },
              },
            },
          },
        },
      },
    },
  },
}
```

注意:

- 各ボットをギルドに招待し、Message Content Intent を有効にします。
- トークンは `channels.discord.accounts.<id>.token` に保存します（デフォルトアカウントは `DISCORD_BOT_TOKEN` を使用可能）。

### エージェントごとの Telegram ボット

```json5
{
  agents: {
    list: [
      { id: "main", workspace: "~/.openclaw/workspace-main" },
      { id: "alerts", workspace: "~/.openclaw/workspace-alerts" },
    ],
  },
  bindings: [
    { agentId: "main", match: { channel: "telegram", accountId: "default" } },
    { agentId: "alerts", match: { channel: "telegram", accountId: "alerts" } },
  ],
  channels: {
    telegram: {
      accounts: {
        default: {
          botToken: "123456:ABC...",
          dmPolicy: "pairing",
        },
        alerts: {
          botToken: "987654:XYZ...",
          dmPolicy: "allowlist",
          allowFrom: ["tg:123456789"],
        },
      },
    },
  },
}
```

注意:

- BotFather でエージェントごとに 1 つのボットを作成し、各トークンをコピーします。
- トークンは `channels.telegram.accounts.<id>.botToken` に保存します（デフォルトアカウントは `TELEGRAM_BOT_TOKEN` を使用可能）。

### エージェントごとの WhatsApp 番号

Gateway を起動する前に各アカウントをリンクします。

```bash
openclaw channels login --channel whatsapp --account personal
openclaw channels login --channel whatsapp --account biz
```

`~/.openclaw/openclaw.json`（JSON5）:

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

  // 決定論的ルーティング: 最初のマッチが優先（最も詳細なものを先に）。
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // オプションのピアごとのオーバーライド（例: 特定のグループを work エージェントに送る）。
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // デフォルトでオフ: エージェント間メッセージングは明示的に有効化およびアローリスト登録が必要。
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
          // オプションのオーバーライド。デフォルト: ~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // オプションのオーバーライド。デフォルト: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## 例: WhatsApp 日常チャット + Telegram 深い作業

チャンネルごとに分割: WhatsApp を日常エージェントに、Telegram を Opus エージェントにルーティングします。

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

注意:

- チャンネルに複数のアカウントがある場合は、バインディングに `accountId` を追加します（例: `{ channel: "whatsapp", accountId: "personal" }`）。
- 特定の DM/グループを Opus に送りながら残りを chat に保つには、そのピアの `match.peer` バインディングを追加します。ピアマッチは常にチャンネル全体のルールより優先されます。

## 例: 同じチャンネルで 1 つのピアを Opus へ

WhatsApp を高速エージェントで処理しながら、1 つの DM を Opus にルーティングします。

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
    {
      agentId: "opus",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551234567" } },
    },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

ピアバインディングは常に優先されるため、チャンネル全体のルールより上に配置してください。

## WhatsApp グループにバインドされたファミリーエージェント

専用のファミリーエージェントを 1 つの WhatsApp グループにバインドし、メンションゲーティングとより厳格なツールポリシーを設定します。

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

注意:

- ツールの許可/拒否リストは**ツール**であり、スキルではありません。スキルがバイナリを実行する必要がある場合は、`exec` が許可されてバイナリがサンドボックス内に存在することを確認してください。
- より厳格なゲーティングには、`agents.list[].groupChat.mentionPatterns` を設定し、チャンネルのグループアローリストを有効に保ちます。

## エージェントごとのサンドボックスとツール設定

v2026.1.6 以降、各エージェントは独自のサンドボックスとツール制限を持てます。

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // personal エージェントはサンドボックスなし
        },
        // ツール制限なし - すべてのツールが使用可能
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // 常にサンドボックス
          scope: "agent",  // エージェントごとに 1 つのコンテナ
          docker: {
            // コンテナ作成後のオプションの一回限りのセットアップ
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // read ツールのみ
          deny: ["exec", "write", "edit", "apply_patch"],    // その他を拒否
        },
      },
    ],
  },
}
```

注意: `setupCommand` は `sandbox.docker` 以下にあり、コンテナ作成時に一度だけ実行されます。解決されたスコープが `"shared"` の場合、エージェントごとの `sandbox.docker.*` オーバーライドは無視されます。

**メリット:**

- **セキュリティ分離**: 信頼できないエージェントのツールを制限する
- **リソース管理**: 特定のエージェントをサンドボックス化し、他はホストで実行する
- **柔軟なポリシー**: エージェントごとに異なる権限

注意: `tools.elevated` は**グローバル**で送信者ベースです。エージェントごとに設定はできません。エージェントごとの境界が必要な場合は、`agents.list[].tools` を使って `exec` を拒否してください。グループのターゲティングには `agents.list[].groupChat.mentionPatterns` を使用し、@メンションが意図したエージェントに正確にマッピングされるようにしてください。

詳細な例については[マルチエージェントサンドボックスとツール](/tools/multi-agent-sandbox-tools)を参照してください。
