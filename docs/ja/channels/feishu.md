---
summary: "Feishu ボットの概要、機能、および設定"
read_when:
  - Feishu/Lark ボットを接続したい場合
  - Feishu チャンネルを設定している場合
title: Feishu
x-i18n:
  source_path: channels/feishu.md
  source_hash: c9349983562d1a98
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:04Z
---

# Feishu ボット

Feishu（Lark）は、企業でメッセージングやコラボレーションに使用されるチームチャットプラットフォームです。このプラグインは、プラットフォームの WebSocket イベントサブスクリプションを使用して OpenClaw を Feishu/Lark ボットに接続し、公開 Webhook URL を公開することなくメッセージを受信できるようにします。

---

## 必要なプラグイン

Feishu プラグインをインストールします。

```bash
openclaw plugins install @openclaw/feishu
```

ローカルチェックアウト（git リポジトリから実行する場合）:

```bash
openclaw plugins install ./extensions/feishu
```

---

## クイックスタート

Feishu チャンネルを追加する方法は 2 つあります。

### 方法 1: オンボーディングウィザード（推奨）

OpenClaw をインストールしたばかりの場合は、ウィザードを実行します。

```bash
openclaw onboard
```

ウィザードでは、次の内容を順に案内します。

1. Feishu アプリの作成と認証情報の取得
2. OpenClaw へのアプリ認証情報の設定
3. ゲートウェイの起動

✅ **設定後**、ゲートウェイのステータスを確認します。

- `openclaw gateway status`
- `openclaw logs --follow`

### 方法 2: CLI セットアップ

初期インストールをすでに完了している場合は、CLI からチャンネルを追加します。

```bash
openclaw channels add
```

**Feishu** を選択し、App ID と App Secret を入力します。

✅ **設定後**、ゲートウェイを管理します。

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## ステップ 1: Feishu アプリの作成

### 1. Feishu Open Platform を開く

[Feishu Open Platform](https://open.feishu.cn/app) にアクセスしてサインインします。

Lark（グローバル）テナントの場合は、[https://open.larksuite.com/app](https://open.larksuite.com/app) を使用し、Feishu 設定で `domain: "lark"` を設定してください。

### 2. アプリを作成する

1. **Create enterprise app** をクリックします。
2. アプリ名と説明を入力します。
3. アプリアイコンを選択します。

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. 認証情報をコピーする

**Credentials & Basic Info** から、次をコピーします。

- **App ID**（形式: `cli_xxx`）
- **App Secret**

❗ **重要:** App Secret は厳重に管理してください。

![Get credentials](../images/feishu-step3-credentials.png)

### 4. 権限を設定する

**Permissions** で **Batch import** をクリックし、次を貼り付けます。

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
  }
}
```

![Configure permissions](../images/feishu-step4-permissions.png)

### 5. ボット機能を有効化する

**App Capability** > **Bot** で次を行います。

1. ボット機能を有効化します。
2. ボット名を設定します。

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. イベントサブスクリプションを設定する

⚠️ **重要:** イベントサブスクリプションを設定する前に、次を確認してください。

1. Feishu 向けに `openclaw channels add` をすでに実行していること
2. ゲートウェイが実行中であること（`openclaw gateway status`）

**Event Subscription** で次を設定します。

1. **Use long connection to receive events**（WebSocket）を選択します。
2. イベント `im.message.receive_v1` を追加します。

⚠️ ゲートウェイが起動していない場合、ロングコネクションの設定が保存に失敗することがあります。

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. アプリを公開する

1. **Version Management & Release** でバージョンを作成します。
2. レビューに提出して公開します。
3. 管理者の承認を待ちます（エンタープライズアプリは通常自動承認されます）。

---

## ステップ 2: OpenClaw の設定

### ウィザードで設定する（推奨）

```bash
openclaw channels add
```

**Feishu** を選択し、App ID と App Secret を貼り付けます。

### 設定ファイルで設定する

`~/.openclaw/openclaw.json` を編集します。

```json5
{
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "My AI assistant",
        },
      },
    },
  },
}
```

### 環境変数で設定する

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Lark（グローバル）ドメイン

テナントが Lark（国際版）の場合は、ドメインを `lark`（または完全なドメイン文字列）に設定します。これは `channels.feishu.domain` で設定するか、アカウントごと（`channels.feishu.accounts.<id>.domain`）に設定できます。

```json5
{
  channels: {
    feishu: {
      domain: "lark",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
        },
      },
    },
  },
}
```

---

## ステップ 3: 起動とテスト

### 1. ゲートウェイを起動する

```bash
openclaw gateway
```

### 2. テストメッセージを送信する

Feishu でボットを見つけ、メッセージを送信します。

### 3. ペアリングを承認する

デフォルトでは、ボットはペアリングコードを返信します。次を実行して承認します。

```bash
openclaw pairing approve feishu <CODE>
```

承認後、通常どおりチャットできます。

---

## 概要

- **Feishu ボットチャンネル**: ゲートウェイによって管理される Feishu ボット
- **決定的ルーティング**: 返信は常に Feishu に戻ります
- **セッション分離**: ダイレクトメッセージはメインセッションを共有し、グループは分離されます
- **WebSocket 接続**: Feishu SDK によるロングコネクションで、公開 URL は不要です

---

## アクセス制御

### ダイレクトメッセージ

- **デフォルト**: `dmPolicy: "pairing"`（不明なユーザーにはペアリングコードが発行されます）
- **ペアリングを承認**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **許可リストモード**: 許可された Open ID を `channels.feishu.allowFrom` に設定します

### グループチャット

**1. グループポリシー**（`channels.feishu.groupPolicy`）:

- `"open"` = グループ内の全員を許可（デフォルト）
- `"allowlist"` = `groupAllowFrom` のみ許可
- `"disabled"` = グループメッセージを無効化

**2. メンション要件**（`channels.feishu.groups.<chat_id>.requireMention`）:

- `true` = @メンション必須（デフォルト）
- `false` = メンションなしで応答

---

## グループ設定の例

### すべてのグループを許可し、@メンション必須（デフォルト）

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // Default requireMention: true
    },
  },
}
```

### すべてのグループを許可し、@メンション不要

```json5
{
  channels: {
    feishu: {
      groups: {
        oc_xxx: { requireMention: false },
      },
    },
  },
}
```

### グループ内で特定ユーザーのみ許可

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["ou_xxx", "ou_yyy"],
    },
  },
}
```

---

## グループ / ユーザー ID の取得

### グループ ID（chat_id）

グループ ID は `oc_xxx` のような形式です。

**方法 1（推奨）**

1. ゲートウェイを起動し、グループ内でボットに @メンションします
2. `openclaw logs --follow` を実行し、`chat_id` を確認します

**方法 2**

Feishu API デバッガーを使用してグループチャットを一覧表示します。

### ユーザー ID（open_id）

ユーザー ID は `ou_xxx` のような形式です。

**方法 1（推奨）**

1. ゲートウェイを起動し、ボットに DM を送信します
2. `openclaw logs --follow` を実行し、`open_id` を確認します

**方法 2**

ペアリングリクエストからユーザーの Open ID を確認します。

```bash
openclaw pairing list feishu
```

---

## 一般的なコマンド

| Command   | Description              |
| --------- | ------------------------ |
| `/status` | ボットのステータスを表示 |
| `/reset`  | セッションをリセット     |
| `/model`  | モデルを表示 / 切り替え  |

> 注記: Feishu は現時点でネイティブのコマンドメニューをサポートしていないため、コマンドはテキストとして送信する必要があります。

## ゲートウェイ管理コマンド

| Command                    | Description                               |
| -------------------------- | ----------------------------------------- |
| `openclaw gateway status`  | ゲートウェイのステータスを表示            |
| `openclaw gateway install` | ゲートウェイサービスをインストール / 起動 |
| `openclaw gateway stop`    | ゲートウェイサービスを停止                |
| `openclaw gateway restart` | ゲートウェイサービスを再起動              |
| `openclaw logs --follow`   | ゲートウェイログを追跡                    |

---

## トラブルシューティング

### グループチャットでボットが応答しない

1. ボットがグループに追加されていることを確認します
2. ボットに @メンションしていることを確認します（デフォルト動作）
3. `groupPolicy` が `"disabled"` に設定されていないことを確認します
4. ログを確認します: `openclaw logs --follow`

### ボットがメッセージを受信しない

1. アプリが公開・承認されていることを確認します
2. イベントサブスクリプションに `im.message.receive_v1` が含まれていることを確認します
3. **ロングコネクション** が有効になっていることを確認します
4. アプリの権限が完全であることを確認します
5. ゲートウェイが実行中であることを確認します: `openclaw gateway status`
6. ログを確認します: `openclaw logs --follow`

### App Secret の漏えい

1. Feishu Open Platform で App Secret をリセットします
2. 設定内の App Secret を更新します
3. ゲートウェイを再起動します

### メッセージ送信の失敗

1. アプリに `im:message:send_as_bot` の権限があることを確認します
2. アプリが公開されていることを確認します
3. 詳細なエラーについてログを確認します

---

## 高度な設定

### 複数アカウント

```json5
{
  channels: {
    feishu: {
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "Primary bot",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

### メッセージ制限

- `textChunkLimit`: 送信テキストのチャンクサイズ（デフォルト: 2000 文字）
- `mediaMaxMb`: メディアのアップロード / ダウンロード制限（デフォルト: 30MB）

### ストリーミング

Feishu はインタラクティブカードによるストリーミング返信をサポートしています。有効にすると、テキスト生成に合わせてカードが更新されます。

```json5
{
  channels: {
    feishu: {
      streaming: true, // enable streaming card output (default true)
      blockStreaming: true, // enable block-level streaming (default true)
    },
  },
}
```

完全な返信を生成してから送信する場合は、`streaming: false` を設定します。

### マルチエージェントルーティング

`bindings` を使用して、Feishu の DM やグループを異なるエージェントにルーティングします。

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "clawd-fan",
        workspace: "/home/user/clawd-fan",
        agentDir: "/home/user/.openclaw/agents/clawd-fan/agent",
      },
      {
        id: "clawd-xi",
        workspace: "/home/user/clawd-xi",
        agentDir: "/home/user/.openclaw/agents/clawd-xi/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_yyy" },
      },
    },
    {
      agentId: "clawd-xi",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

ルーティングフィールド:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"dm"` または `"group"`
- `match.peer.id`: ユーザー Open ID（`ou_xxx`）またはグループ ID（`oc_xxx`）

取得方法のヒントについては、[グループ / ユーザー ID の取得](#get-groupuser-ids) を参照してください。

---

## 設定リファレンス

完全な設定: [Gateway configuration](/gateway/configuration)

主なオプション:

| Setting                                           | Description                            | Default   |
| ------------------------------------------------- | -------------------------------------- | --------- |
| `channels.feishu.enabled`                         | チャンネルの有効 / 無効                | `true`    |
| `channels.feishu.domain`                          | API ドメイン（`feishu` または `lark`） | `feishu`  |
| `channels.feishu.accounts.<id>.appId`             | App ID                                 | -         |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                             | -         |
| `channels.feishu.accounts.<id>.domain`            | アカウントごとの API ドメイン上書き    | `feishu`  |
| `channels.feishu.dmPolicy`                        | DM ポリシー                            | `pairing` |
| `channels.feishu.allowFrom`                       | DM 許可リスト（open_id のリスト）      | -         |
| `channels.feishu.groupPolicy`                     | グループポリシー                       | `open`    |
| `channels.feishu.groupAllowFrom`                  | グループ許可リスト                     | -         |
| `channels.feishu.groups.<chat_id>.requireMention` | @メンション必須                        | `true`    |
| `channels.feishu.groups.<chat_id>.enabled`        | グループ有効化                         | `true`    |
| `channels.feishu.textChunkLimit`                  | メッセージチャンクサイズ               | `2000`    |
| `channels.feishu.mediaMaxMb`                      | メディアサイズ制限                     | `30`      |
| `channels.feishu.streaming`                       | ストリーミングカード出力を有効化       | `true`    |
| `channels.feishu.blockStreaming`                  | ブロックストリーミングを有効化         | `true`    |

---

## dmPolicy リファレンス

| Value         | Behavior                                                                      |
| ------------- | ----------------------------------------------------------------------------- |
| `"pairing"`   | **デフォルト。** 不明なユーザーにはペアリングコードが発行され、承認が必要です |
| `"allowlist"` | `allowFrom` に含まれるユーザーのみチャット可能                                |
| `"open"`      | すべてのユーザーを許可（allowFrom に `"*"` が必要）                           |
| `"disabled"`  | DM を無効化                                                                   |

---

## 対応メッセージタイプ

### 受信

- ✅ テキスト
- ✅ リッチテキスト（post）
- ✅ 画像
- ✅ ファイル
- ✅ 音声
- ✅ 動画
- ✅ スタンプ

### 送信

- ✅ テキスト
- ✅ 画像
- ✅ ファイル
- ✅ 音声
- ⚠️ リッチテキスト（部分対応）
