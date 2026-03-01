---
summary: "Feishuボットの概要、機能、設定"
read_when:
  - Feishu/Larkボットを接続したいとき
  - Feishuチャンネルを設定するとき
title: Feishu
---

# Feishuボット

Feishu（Lark）は企業がメッセージングとコラボレーションに使用するチームチャットプラットフォームです。このプラグインはFeishu/LarkボットとOpenClawを接続し、プラットフォームのWebSocketイベントサブスクリプションを使用して、パブリックなウェブフックURLを公開せずにメッセージを受信できます。

---

## プラグインが必要です

Feishuプラグインをインストールします:

```bash
openclaw plugins install @openclaw/feishu
```

ローカルチェックアウト（gitリポジトリから実行する場合）:

```bash
openclaw plugins install ./extensions/feishu
```

---

## クイックスタート

Feishuチャンネルを追加するには2つの方法があります:

### 方法1: オンボーディングウィザード（推奨）

OpenClawをインストールしたばかりの場合、ウィザードを実行します:

```bash
openclaw onboard
```

ウィザードは以下を案内します:

1. Feishuアプリの作成と認証情報の収集
2. OpenClawでのアプリ認証情報の設定
3. Gatewayの起動

設定後、Gatewayのステータスを確認します:

- `openclaw gateway status`
- `openclaw logs --follow`

### 方法2: CLIセットアップ

初期インストールが完了している場合、CLI経由でチャンネルを追加します:

```bash
openclaw channels add
```

**Feishu**を選択し、App IDとApp Secretを入力します。

設定後、Gatewayを管理します:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## ステップ1: Feishuアプリの作成

### 1. Feishu Open Platformを開く

[Feishu Open Platform](https://open.feishu.cn/app)にアクセスしてサインインします。

Lark（グローバル）テナントは[https://open.larksuite.com/app](https://open.larksuite.com/app)を使用し、Feishu設定で`domain: "lark"`を設定してください。

### 2. アプリを作成する

1. **Create enterprise app**をクリック
2. アプリ名 + 説明を入力
3. アプリアイコンを選択

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. 認証情報をコピーする

**Credentials & Basic Info**から以下をコピーします:

- **App ID**（形式: `cli_xxx`）
- **App Secret**

重要: App Secretは非公開にしてください。

![Get credentials](../images/feishu-step3-credentials.png)

### 4. 権限を設定する

**Permissions**で、**Batch import**をクリックして以下を貼り付けます:

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "cardkit:card:read",
      "cardkit:card:write",
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

### 5. ボット機能を有効にする

**App Capability** > **Bot**で:

1. ボット機能を有効にする
2. ボット名を設定する

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. イベントサブスクリプションを設定する

重要: イベントサブスクリプションを設定する前に、以下を確認してください:

1. Feishu用に`openclaw channels add`を既に実行済み
2. Gatewayが実行中（`openclaw gateway status`）

**Event Subscription**で:

1. **Use long connection to receive events**（WebSocket）を選択
2. イベント`im.message.receive_v1`を追加

Gatewayが実行されていない場合、長時間接続のセットアップが保存に失敗する可能性があります。

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. アプリを公開する

1. **Version Management & Release**でバージョンを作成
2. レビューに提出して公開
3. 管理者の承認を待ちます（エンタープライズアプリは通常自動承認）

---

## ステップ2: OpenClawの設定

### ウィザードで設定（推奨）

```bash
openclaw channels add
```

**Feishu**を選択し、App ID + App Secretを貼り付けます。

### 設定ファイルで設定

`~/.openclaw/openclaw.json`を編集します:

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

`connectionMode: "webhook"`を使用する場合は、`verificationToken`を設定してください。Feishuウェブフックサーバーはデフォルトで`127.0.0.1`にバインドします。意図的に異なるバインドアドレスが必要な場合のみ`webhookHost`を設定してください。

### 環境変数で設定

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Lark（グローバル）ドメイン

テナントがLark（国際版）の場合、ドメインを`lark`（または完全なドメイン文字列）に設定します。`channels.feishu.domain`またはアカウントごと（`channels.feishu.accounts.<id>.domain`）に設定できます。

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

### クォータ最適化フラグ

2つのオプションフラグでFeishu APIの使用量を削減できます:

- `typingIndicator`（デフォルト`true`）: `false`の場合、タイピングリアクション呼び出しをスキップします。
- `resolveSenderNames`（デフォルト`true`）: `false`の場合、送信者プロファイルルックアップ呼び出しをスキップします。

トップレベルまたはアカウントごとに設定します:

```json5
{
  channels: {
    feishu: {
      typingIndicator: false,
      resolveSenderNames: false,
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          typingIndicator: true,
          resolveSenderNames: false,
        },
      },
    },
  },
}
```

---

## ステップ3: 起動 + テスト

### 1. Gatewayを起動

```bash
openclaw gateway
```

### 2. テストメッセージを送信

Feishuでボットを見つけてメッセージを送信します。

### 3. ペアリングを承認

デフォルトでは、ボットはペアリングコードで返信します。承認します:

```bash
openclaw pairing approve feishu <CODE>
```

承認後、通常どおりチャットできます。

---

## 概要

- **Feishuボットチャンネル**: Gatewayが管理するFeishuボット
- **決定論的ルーティング**: 返信は常にFeishuに戻ります
- **セッション分離**: DMはメインセッションを共有。グループは分離されます
- **WebSocket接続**: Feishu SDK経由の長時間接続、パブリックURL不要

---

## アクセス制御

### ダイレクトメッセージ

- **デフォルト**: `dmPolicy: "pairing"`（未知のユーザーにペアリングコードが送信されます）
- **ペアリング承認**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **許可リストモード**: `channels.feishu.allowFrom`に許可するOpen IDを設定

### グループチャット

**1. グループポリシー**（`channels.feishu.groupPolicy`）:

- `"open"` = グループで全員を許可（デフォルト）
- `"allowlist"` = `groupAllowFrom`のみ許可
- `"disabled"` = グループメッセージを無効化

**2. メンション要件**（`channels.feishu.groups.<chat_id>.requireMention`）:

- `true` = @メンションが必要（デフォルト）
- `false` = メンションなしで応答

---

## グループ設定例

### すべてのグループを許可、@メンション必要（デフォルト）

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // デフォルトのrequireMention: true
    },
  },
}
```

### すべてのグループを許可、@メンション不要

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

### 特定のグループのみ許可

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      // FeishuグループID（chat_id）の形式: oc_xxx
      groupAllowFrom: ["oc_xxx", "oc_yyy"],
    },
  },
}
```

### 特定のユーザーにグループ内の制御コマンド（例: /reset、/new）の実行を許可

グループ自体を許可することに加え、制御コマンドは**送信者**のopen_idでゲートされます。

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["oc_xxx"],
      groups: {
        oc_xxx: {
          // FeishuユーザーID（open_id）の形式: ou_xxx
          allowFrom: ["ou_user1", "ou_user2"],
        },
      },
    },
  },
}
```

---

## グループ/ユーザーIDの取得

### グループID（chat_id）

グループIDの形式は`oc_xxx`です。

**方法1（推奨）**

1. Gatewayを起動し、グループでボットに@メンションします
2. `openclaw logs --follow`を実行して`chat_id`を確認します

**方法2**

Feishu APIデバッガーを使用してグループチャットを一覧表示します。

### ユーザーID（open_id）

ユーザーIDの形式は`ou_xxx`です。

**方法1（推奨）**

1. Gatewayを起動し、ボットにDMを送信します
2. `openclaw logs --follow`を実行して`open_id`を確認します

**方法2**

ペアリングリクエストでユーザーOpen IDを確認します:

```bash
openclaw pairing list feishu
```

---

## よく使うコマンド

| コマンド  | 説明             |
| --------- | ---------------- |
| `/status` | ボットステータスを表示 |
| `/reset`  | セッションをリセット   |
| `/model`  | モデルの表示/切替     |

> 注意: Feishuはまだネイティブコマンドメニューをサポートしていないため、コマンドはテキストとして送信する必要があります。

## Gateway管理コマンド

| コマンド                     | 説明                        |
| ---------------------------- | --------------------------- |
| `openclaw gateway status`    | Gatewayステータスを表示     |
| `openclaw gateway install`   | Gatewayサービスをインストール/起動 |
| `openclaw gateway stop`      | Gatewayサービスを停止       |
| `openclaw gateway restart`   | Gatewayサービスを再起動     |
| `openclaw logs --follow`     | Gatewayログをテール         |

---

## トラブルシューティング

### ボットがグループチャットで応答しない

1. ボットがグループに追加されていることを確認
2. ボットに@メンションしていることを確認（デフォルト動作）
3. `groupPolicy`が`"disabled"`に設定されていないことを確認
4. ログを確認: `openclaw logs --follow`

### ボットがメッセージを受信しない

1. アプリが公開され承認されていることを確認
2. イベントサブスクリプションに`im.message.receive_v1`が含まれていることを確認
3. **長時間接続**が有効であることを確認
4. アプリの権限が完全であることを確認
5. Gatewayが実行中であることを確認: `openclaw gateway status`
6. ログを確認: `openclaw logs --follow`

### App Secretの漏洩

1. Feishu Open PlatformでApp Secretをリセット
2. 設定のApp Secretを更新
3. Gatewayを再起動

### メッセージ送信の失敗

1. アプリが`im:message:send_as_bot`権限を持っていることを確認
2. アプリが公開されていることを確認
3. ログで詳細なエラーを確認

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

- `textChunkLimit`: 送信テキストチャンクサイズ（デフォルト: 2000文字）
- `mediaMaxMb`: メディアアップロード/ダウンロード制限（デフォルト: 30MB）

### ストリーミング

Feishuはインタラクティブカードによるストリーミング返信をサポートしています。有効にすると、ボットはテキスト生成中にカードを更新します。

```json5
{
  channels: {
    feishu: {
      streaming: true, // ストリーミングカード出力を有効化（デフォルトtrue）
      blockStreaming: true, // ブロックレベルストリーミングを有効化（デフォルトtrue）
    },
  },
}
```

完全な返信を待ってから送信するには`streaming: false`を設定してください。

### マルチエージェントルーティング

`bindings`を使用してFeishu DMやグループを異なるエージェントにルーティングします。

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
        peer: { kind: "direct", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "direct", id: "ou_yyy" },
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
- `match.peer.kind`: `"direct"`または`"group"`
- `match.peer.id`: ユーザーOpen ID（`ou_xxx`）またはグループID（`oc_xxx`）

ルックアップのヒントは[グループ/ユーザーIDの取得](#グループユーザーidの取得)を参照してください。

---

## 設定リファレンス

完全な設定: [Gateway設定](/gateway/configuration)

主要オプション:

| 設定                                              | 説明                          | デフォルト       |
| ------------------------------------------------- | ----------------------------- | ---------------- |
| `channels.feishu.enabled`                         | チャンネルの有効/無効         | `true`           |
| `channels.feishu.domain`                          | APIドメイン（`feishu`または`lark`） | `feishu`    |
| `channels.feishu.connectionMode`                  | イベントトランスポートモード  | `websocket`      |
| `channels.feishu.verificationToken`               | ウェブフックモードで必要      | -                |
| `channels.feishu.webhookPath`                     | ウェブフックルートパス        | `/feishu/events` |
| `channels.feishu.webhookHost`                     | ウェブフックバインドホスト    | `127.0.0.1`      |
| `channels.feishu.webhookPort`                     | ウェブフックバインドポート    | `3000`           |
| `channels.feishu.accounts.<id>.appId`             | App ID                        | -                |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                    | -                |
| `channels.feishu.accounts.<id>.domain`            | アカウントごとのAPIドメインオーバーライド | `feishu` |
| `channels.feishu.dmPolicy`                        | DMポリシー                    | `pairing`        |
| `channels.feishu.allowFrom`                       | DM許可リスト（open_idリスト） | -                |
| `channels.feishu.groupPolicy`                     | グループポリシー              | `open`           |
| `channels.feishu.groupAllowFrom`                  | グループ許可リスト            | -                |
| `channels.feishu.groups.<chat_id>.requireMention` | @メンション必要               | `true`           |
| `channels.feishu.groups.<chat_id>.enabled`        | グループの有効化              | `true`           |
| `channels.feishu.textChunkLimit`                  | メッセージチャンクサイズ      | `2000`           |
| `channels.feishu.mediaMaxMb`                      | メディアサイズ制限            | `30`             |
| `channels.feishu.streaming`                       | ストリーミングカード出力の有効化 | `true`        |
| `channels.feishu.blockStreaming`                   | ブロックストリーミングの有効化 | `true`          |

---

## dmPolicyリファレンス

| 値            | 動作                                                          |
| ------------- | ------------------------------------------------------------- |
| `"pairing"`   | **デフォルト。** 未知のユーザーにペアリングコードが送信されます。承認が必要 |
| `"allowlist"` | `allowFrom`のユーザーのみチャット可能                          |
| `"open"`      | すべてのユーザーを許可（allowFromに`"*"`が必要）               |
| `"disabled"`  | DMを無効化                                                     |

---

## サポートされるメッセージタイプ

### 受信

- テキスト
- リッチテキスト（post）
- 画像
- ファイル
- 音声
- 動画
- スタンプ

### 送信

- テキスト
- 画像
- ファイル
- 音声
- リッチテキスト（部分的なサポート）
