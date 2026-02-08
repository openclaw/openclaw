---
summary: 「Telegram ボットのサポート状況、機能、および設定」
read_when:
  - Telegram 機能や webhook に取り組むとき
title: 「Telegram」
x-i18n:
  source_path: channels/telegram.md
  source_hash: 604e2dc12d2b776d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:22:07Z
---

# Telegram（Bot API）

ステータス: grammY 経由でのボット DM + グループに対して本番対応。デフォルトはロングポーリング、webhook はオプションです。

## クイックセットアップ（初心者向け）

1. **@BotFather**（[直リンク](https://t.me/BotFather)）でボットを作成します。ハンドルが正確に `@BotFather` であることを確認し、トークンをコピーします。
2. トークンを設定します:
   - 環境変数: `TELEGRAM_BOT_TOKEN=...`
   - または設定: `channels.telegram.botToken: "..."`。
   - 両方が設定されている場合は、設定が優先されます（環境変数のフォールバックはデフォルトアカウントのみ）。
3. ゲートウェイを起動します。
4. DM アクセスはデフォルトでペアリングです。初回接触時にペアリングコードを承認します。

最小構成:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
    },
  },
}
```

## 概要

- Gateway（ゲートウェイ）が所有する Telegram Bot API チャンネルです。
- 決定的ルーティング: 返信は必ず Telegram に戻り、モデルがチャンネルを選択することはありません。
- DM はエージェントのメインセッションを共有し、グループは分離されます（`agent:<agentId>:telegram:group:<chatId>`）。

## セットアップ（高速パス）

### 1) ボットトークンを作成（BotFather）

1. Telegram を開き、**@BotFather**（[直リンク](https://t.me/BotFather)）とチャットします。ハンドルが正確に `@BotFather` であることを確認します。
2. `/newbot` を実行し、指示に従います（名前 + `bot` で終わるユーザー名）。
3. トークンをコピーして安全に保管します。

任意の BotFather 設定:

- `/setjoingroups` — ボットをグループに追加できるかを許可／拒否します。
- `/setprivacy` — ボットがすべてのグループメッセージを見るかどうかを制御します。

### 2) トークンを設定（環境変数または設定）

例:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

環境変数オプション: `TELEGRAM_BOT_TOKEN=...`（デフォルトアカウントで有効）。
環境変数と設定の両方がある場合、設定が優先されます。

マルチアカウント対応: アカウントごとのトークンと任意の `name` を指定して `channels.telegram.accounts` を使用します。共通パターンは [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) を参照してください。

3. ゲートウェイを起動します。トークンが解決されると Telegram が開始されます（設定優先、環境変数はフォールバック）。
4. DM アクセスはデフォルトでペアリングです。ボットに最初に連絡したときにコードを承認します。
5. グループの場合: ボットを追加し、プライバシー／管理者の挙動を決定し（下記参照）、`channels.telegram.groups` を設定してメンションゲーティング + 許可リストを制御します。

## トークン + プライバシー + 権限（Telegram 側）

### トークン作成（BotFather）

- `/newbot` はボットを作成し、トークンを返します（秘密にしてください）。
- トークンが漏洩した場合は、@BotFather で失効／再生成し、設定を更新します。

### グループメッセージの可視性（プライバシーモード）

Telegram ボットはデフォルトで **プライバシーモード** が有効で、受信できるグループメッセージが制限されます。
ボットが _すべて_ のグループメッセージを見る必要がある場合、次の 2 つの方法があります。

- `/setprivacy` でプライバシーモードを無効化 **または**
- ボットをグループ **管理者** として追加（管理者ボットはすべてのメッセージを受信します）。

**注記:** プライバシーモードを切り替えた場合、変更を反映するには各グループからボットを削除して再追加する必要があります。

### グループ権限（管理者権限）

管理者ステータスはグループ内（Telegram UI）で設定します。管理者ボットは常にすべての
グループメッセージを受信するため、完全な可視性が必要な場合は管理者を使用してください。

## 動作の仕組み（挙動）

- 受信メッセージは、返信コンテキストとメディアプレースホルダーを含む共有チャンネルエンベロープに正規化されます。
- グループ返信はデフォルトでメンションが必要です（ネイティブ @mention または `agents.list[].groupChat.mentionPatterns` / `messages.groupChat.mentionPatterns`）。
- マルチエージェントの上書き: `agents.list[].groupChat.mentionPatterns` にエージェントごとのパターンを設定します。
- 返信は常に同じ Telegram チャットにルーティングされます。
- ロングポーリングは grammY runner を使用し、チャットごとのシーケンシングを行います。全体の同時実行数は `agents.defaults.maxConcurrent` で上限が設定されます。
- Telegram Bot API は既読通知をサポートしていないため、`sendReadReceipts` オプションはありません。

## ドラフトストリーミング

OpenClaw は `sendMessageDraft` を使用して Telegram DM で部分的な返信をストリーミングできます。

要件:

- @BotFather でボットにスレッドモード（フォーラムトピックモード）が有効になっていること。
- プライベートチャットのスレッドのみ（Telegram は受信メッセージに `message_thread_id` を含めます）。
- `channels.telegram.streamMode` が `"off"` に設定されていないこと（デフォルト: `"partial"`、`"block"` でチャンク化されたドラフト更新を有効化）。

ドラフトストリーミングは DM 専用です。Telegram はグループやチャンネルではサポートしていません。

## フォーマット（Telegram HTML）

- 送信される Telegram テキストは `parse_mode: "HTML"`（Telegram がサポートするタグのサブセット）を使用します。
- Markdown 風の入力は **Telegram 安全な HTML**（太字／斜体／取り消し線／コード／リンク）にレンダリングされます。ブロック要素はテキストにフラット化され、改行や箇条書きになります。
- モデルからの生 HTML は、Telegram の解析エラーを避けるためエスケープされます。
- Telegram が HTML ペイロードを拒否した場合、OpenClaw は同じメッセージをプレーンテキストとして再試行します。

## コマンド（ネイティブ + カスタム）

OpenClaw は起動時に、`/status`、`/reset`、`/model` などのネイティブコマンドを Telegram のボットメニューに登録します。
設定により、カスタムコマンドをメニューに追加できます。

```json5
{
  channels: {
    telegram: {
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
    },
  },
}
```

## セットアップのトラブルシューティング（コマンド）

- ログに `setMyCommands failed` が表示される場合、`api.telegram.org` への送信 HTTPS／DNS がブロックされていることが多いです。
- `sendMessage` や `sendChatAction` の失敗が見られる場合、IPv6 ルーティングと DNS を確認してください。

詳細: [チャンネルトラブルシューティング](/channels/troubleshooting)。

注記:

- カスタムコマンドは **メニューエントリのみ** です。OpenClaw は、他で処理しない限り実装しません。
- コマンド名は正規化され（先頭の `/` が削除され、小文字化）、`a-z`、`0-9`、`_`（1～32 文字）に一致する必要があります。
- カスタムコマンドは **ネイティブコマンドを上書きできません**。競合は無視され、ログに記録されます。
- `commands.native` が無効の場合、カスタムコマンドのみが登録されます（存在しない場合はクリアされます）。

## 制限

- 送信テキストは `channels.telegram.textChunkLimit` まで分割されます（デフォルト 4000）。
- 任意の改行分割: `channels.telegram.chunkMode="newline"` を設定すると、長さ分割の前に空行（段落境界）で分割します。
- メディアのダウンロード／アップロードは `channels.telegram.mediaMaxMb` までに制限されます（デフォルト 5）。
- Telegram Bot API のリクエストは `channels.telegram.timeoutSeconds` 後にタイムアウトします（grammY 経由でのデフォルトは 500）。長時間のハングを避けるため、低く設定してください。
- グループ履歴コンテキストは `channels.telegram.historyLimit`（または `channels.telegram.accounts.*.historyLimit`）を使用し、`messages.groupChat.historyLimit` にフォールバックします。無効化するには `0` を設定します（デフォルト 50）。
- DM 履歴は `channels.telegram.dmHistoryLimit`（ユーザーターン）で制限できます。ユーザーごとの上書き: `channels.telegram.dms["<user_id>"].historyLimit`。

## グループのアクティベーションモード

デフォルトでは、ボットはグループ内でメンションにのみ応答します（`@botname` または `agents.list[].groupChat.mentionPatterns` のパターン）。挙動を変更するには次を使用します。

### 設定経由（推奨）

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": { requireMention: false }, // always respond in this group
      },
    },
  },
}
```

**重要:** `channels.telegram.groups` を設定すると **許可リスト** が作成され、一覧にあるグループ（または `"*"`）のみが受け入れられます。
フォーラムトピックは、`channels.telegram.groups.<groupId>.topics.<topicId>` にトピックごとの上書きを追加しない限り、親グループの設定（allowFrom、requireMention、skills、prompts）を継承します。

すべてのグループで常時応答を許可する場合:

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: false }, // all groups, always respond
      },
    },
  },
}
```

すべてのグループでメンションのみを維持する場合（デフォルト）:

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: true }, // or omit groups entirely
      },
    },
  },
}
```

### コマンド経由（セッションレベル）

グループ内で送信します。

- `/activation always` - すべてのメッセージに応答
- `/activation mention` - メンション必須（デフォルト）

**注記:** コマンドはセッション状態のみを更新します。再起動後も持続させるには設定を使用してください。

### グループチャット ID の取得

グループ内の任意のメッセージを `@userinfobot` または `@getidsbot` に転送すると、チャット ID（`-1001234567890` のような負の数）が表示されます。

**ヒント:** 自分のユーザー ID を取得するには、ボットに DM を送るとユーザー ID（ペアリングメッセージ）が返信されます。または、コマンドが有効になっていれば `/whoami` を使用します。

**プライバシー注記:** `@userinfobot` はサードパーティ製ボットです。必要であれば、ボットをグループに追加してメッセージを送信し、`openclaw logs --follow` を使って `chat.id` を読み取るか、Bot API の `getUpdates` を使用してください。

## 設定の書き込み

デフォルトでは、チャンネルイベントまたは `/config set|unset` によってトリガーされた設定更新の書き込みが Telegram に許可されています。

これは次の場合に発生します。

- グループがスーパーグループにアップグレードされ、Telegram が `migrate_to_chat_id` を発行した場合（チャット ID が変更されます）。OpenClaw は `channels.telegram.groups` を自動的に移行できます。
- Telegram チャットで `/config set` または `/config unset` を実行した場合（`commands.config: true` が必要）。

無効化するには次を設定します。

```json5
{
  channels: { telegram: { configWrites: false } },
}
```

## トピック（フォーラムスーパーグループ）

Telegram のフォーラムトピックには、メッセージごとに `message_thread_id` が含まれます。OpenClaw は次を行います。

- 各トピックを分離するため、Telegram グループのセッションキーに `:topic:<threadId>` を付加します。
- 応答がトピック内に留まるよう、`message_thread_id` を指定して入力中インジケーターと返信を送信します。
- 一般トピック（スレッド ID `1`）は特別で、メッセージ送信では `message_thread_id` を省略します（Telegram が拒否するため）が、入力中インジケーターには含めます。
- ルーティング／テンプレート用に、テンプレートコンテキストに `MessageThreadId` + `IsForum` を公開します。
- トピック固有の設定は `channels.telegram.groups.<chatId>.topics.<threadId>`（skills、許可リスト、自動返信、システムプロンプト、無効化）で利用できます。
- トピック設定は、上書きしない限りグループ設定（requireMention、許可リスト、skills、prompts、有効化）を継承します。

プライベートチャットでも、まれに `message_thread_id` が含まれる場合があります。OpenClaw は DM セッションキーを変更しませんが、存在する場合は返信／ドラフトストリーミングにスレッド ID を使用します。

## インラインボタン

Telegram はコールバックボタン付きのインラインキーボードをサポートしています。

```json5
{
  channels: {
    telegram: {
      capabilities: {
        inlineButtons: "allowlist",
      },
    },
  },
}
```

アカウントごとの設定:

```json5
{
  channels: {
    telegram: {
      accounts: {
        main: {
          capabilities: {
            inlineButtons: "allowlist",
          },
        },
      },
    },
  },
}
```

スコープ:

- `off` — インラインボタン無効
- `dm` — DM のみ（グループ宛はブロック）
- `group` — グループのみ（DM 宛はブロック）
- `all` — DM + グループ
- `allowlist` — DM + グループ。ただし `allowFrom`/`groupAllowFrom` で許可された送信者のみ（制御コマンドと同じルール）

デフォルト: `allowlist`。
レガシー: `capabilities: ["inlineButtons"]` = `inlineButtons: "all"`。

### ボタンの送信

メッセージツールで `buttons` パラメータを使用します。

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  message: "Choose an option:",
  buttons: [
    [
      { text: "Yes", callback_data: "yes" },
      { text: "No", callback_data: "no" },
    ],
    [{ text: "Cancel", callback_data: "cancel" }],
  ],
}
```

ユーザーがボタンをクリックすると、コールバックデータが次の形式のメッセージとしてエージェントに送信されます。
`callback_data: value`

### 設定オプション

Telegram の機能は 2 つのレベルで設定できます（上記はオブジェクト形式。レガシーの文字列配列も引き続きサポートされます）。

- `channels.telegram.capabilities`: 全 Telegram アカウントに適用されるグローバル既定の機能設定（上書きされない限り）。
- `channels.telegram.accounts.<account>.capabilities`: 特定のアカウントに対してグローバル既定を上書きする、アカウント別機能設定。

すべての Telegram ボット／アカウントを同一挙動にしたい場合はグローバル設定を使用します。異なる挙動が必要な場合（例: あるアカウントは DM のみ、別のアカウントはグループ可）はアカウント別設定を使用してください。

## アクセス制御（DM + グループ）

### DM アクセス

- デフォルト: `channels.telegram.dmPolicy = "pairing"`。未知の送信者にはペアリングコードが送られ、承認されるまでメッセージは無視されます（コードは 1 時間で失効）。
- 承認方法:
  - `openclaw pairing list telegram`
  - `openclaw pairing approve telegram <CODE>`
- ペアリングは Telegram DM で使用されるデフォルトのトークン交換です。詳細: [ペアリング](/channels/pairing)
- `channels.telegram.allowFrom` は数値のユーザー ID（推奨）または `@username` エントリを受け付けます。ボットのユーザー名ではありません。人間の送信者の ID を使用してください。ウィザードは `@username` を受け付け、可能な場合は数値 ID に解決します。

#### Telegram ユーザー ID の確認方法

より安全（サードパーティなし）:

1. ゲートウェイを起動し、ボットに DM を送信します。
2. `openclaw logs --follow` を実行し、`from.id` を確認します。

代替（公式 Bot API）:

1. ボットに DM を送信します。
2. ボットトークンで更新を取得し、`message.from.id` を読み取ります。

   ```bash
   curl "https://api.telegram.org/bot<bot_token>/getUpdates"
   ```

サードパーティ（プライバシー低）:

- `@userinfobot` または `@getidsbot` に DM を送り、返されるユーザー ID を使用します。

### グループアクセス

2 つの独立した制御があります。

**1. 許可されるグループ**（`channels.telegram.groups` によるグループ許可リスト）:

- `groups` 設定なし = すべてのグループを許可
- `groups` 設定あり = 一覧のグループまたは `"*"` のみ許可
- 例: `"groups": { "-1001234567890": {}, "*": {} }` はすべてのグループを許可

**2. 許可される送信者**（`channels.telegram.groupPolicy` による送信者フィルタリング）:

- `"open"` = 許可されたグループ内のすべての送信者が送信可能
- `"allowlist"` = `channels.telegram.groupAllowFrom` 内の送信者のみ送信可能
- `"disabled"` = グループメッセージを一切受け付けない
  デフォルトは `groupPolicy: "allowlist"`（`groupAllowFrom` を追加するまでブロック）。

多くのユーザーに推奨: `groupPolicy: "allowlist"` + `groupAllowFrom` + `channels.telegram.groups` に特定のグループを列挙

特定のグループで **すべてのメンバー** が発言できるようにしつつ、制御コマンドは許可された送信者のみに制限するには、グループごとの上書きを設定します。

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          groupPolicy: "open",
          requireMention: false,
        },
      },
    },
  },
}
```

## ロングポーリング vs webhook

- デフォルト: ロングポーリング（公開 URL 不要）。
- webhook モード: `channels.telegram.webhookUrl` と `channels.telegram.webhookSecret`（任意で `channels.telegram.webhookPath`）を設定します。
  - ローカルリスナーは `0.0.0.0:8787` にバインドされ、デフォルトで `POST /telegram-webhook` を提供します。
  - 公開 URL が異なる場合は、リバースプロキシを使用し、`channels.telegram.webhookUrl` を公開エンドポイントに向けます。

## 返信スレッディング

Telegram はタグによる任意のスレッド返信をサポートしています。

- `[[reply_to_current]]` -- トリガーとなったメッセージに返信。
- `[[reply_to:<id>]]` -- 特定のメッセージ ID に返信。

`channels.telegram.replyToMode` で制御します。

- `first`（デフォルト）、`all`、`off`。

## 音声メッセージ（ボイス vs ファイル）

Telegram は **ボイスノート**（丸いバブル）と **音声ファイル**（メタデータカード）を区別します。
OpenClaw は後方互換性のため、デフォルトで音声ファイルを使用します。

エージェントの返信でボイスノートのバブルを強制するには、返信内の任意の場所に次のタグを含めます。

- `[[audio_as_voice]]` — ファイルではなくボイスノートとして音声を送信します。

このタグは配信されるテキストから削除されます。他のチャンネルはこのタグを無視します。

メッセージツールで送信する場合は、ボイス対応の音声 `media` URL を `asVoice: true` に設定します
（メディアが存在する場合、`message` は任意です）。

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/voice.ogg",
  asVoice: true,
}
```

## ステッカー

OpenClaw は、インテリジェントなキャッシュを用いて Telegram ステッカーの受信と送信をサポートします。

### ステッカーの受信

ユーザーがステッカーを送信した場合、OpenClaw は種類に応じて処理します。

- **静的ステッカー（WEBP）:** ダウンロードされ、ビジョン処理されます。ステッカーはメッセージ内容に `<media:sticker>` プレースホルダーとして表示されます。
- **アニメーションステッカー（TGS）:** スキップ（Lottie 形式は処理未対応）。
- **ビデオステッカー（WEBM）:** スキップ（ビデオ形式は処理未対応）。

ステッカー受信時に利用可能なテンプレートコンテキストフィールド:

- `Sticker` — 次を含むオブジェクト:
  - `emoji` — ステッカーに関連付けられた絵文字
  - `setName` — ステッカーセット名
  - `fileId` — Telegram ファイル ID（同じステッカーを再送信可能）
  - `fileUniqueId` — キャッシュ参照用の安定 ID
  - `cachedDescription` — 利用可能な場合のキャッシュ済みビジョン説明

### ステッカーキャッシュ

ステッカーは AI のビジョン機能で処理され、説明文が生成されます。同じステッカーが繰り返し送信されることが多いため、OpenClaw は冗長な API 呼び出しを避けるためにこれらの説明をキャッシュします。

**仕組み:**

1. **初回遭遇:** ステッカー画像が AI に送信され、ビジョン解析が行われます。AI は説明文を生成します（例: 「元気よく手を振る漫画風の猫」）。
2. **キャッシュ保存:** 説明文は、ステッカーのファイル ID、絵文字、セット名とともに保存されます。
3. **再遭遇:** 同じステッカーが再び表示された場合、キャッシュされた説明が直接使用され、画像は AI に送信されません。

**キャッシュの場所:** `~/.openclaw/telegram/sticker-cache.json`

**キャッシュエントリ形式:**

```json
{
  "fileId": "CAACAgIAAxkBAAI...",
  "fileUniqueId": "AgADBAADb6cxG2Y",
  "emoji": "👋",
  "setName": "CoolCats",
  "description": "A cartoon cat waving enthusiastically",
  "cachedAt": "2026-01-15T10:30:00.000Z"
}
```

**利点:**

- 同一ステッカーに対するビジョン呼び出しを回避し、API コストを削減
- キャッシュ済みステッカーの高速応答（ビジョン処理の遅延なし）
- キャッシュされた説明に基づくステッカー検索機能を実現

キャッシュはステッカー受信時に自動的に作成されます。手動でのキャッシュ管理は不要です。

### ステッカーの送信

エージェントは `sticker` および `sticker-search` アクションを使用してステッカーを送信／検索できます。これらはデフォルトで無効のため、設定で有効化する必要があります。

```json5
{
  channels: {
    telegram: {
      actions: {
        sticker: true,
      },
    },
  },
}
```

**ステッカーを送信:**

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "123456789",
  fileId: "CAACAgIAAxkBAAI...",
}
```

パラメータ:

- `fileId`（必須）— ステッカーの Telegram ファイル ID。受信時の `Sticker.fileId`、または `sticker-search` の結果から取得します。
- `replyTo`（任意）— 返信先のメッセージ ID。
- `threadId`（任意）— フォーラムトピック用のメッセージスレッド ID。

**ステッカーの検索:**

エージェントは、説明、絵文字、セット名でキャッシュ済みステッカーを検索できます。

```json5
{
  action: "sticker-search",
  channel: "telegram",
  query: "cat waving",
  limit: 5,
}
```

キャッシュから一致するステッカーを返します。

```json5
{
  ok: true,
  count: 2,
  stickers: [
    {
      fileId: "CAACAgIAAxkBAAI...",
      emoji: "👋",
      description: "A cartoon cat waving enthusiastically",
      setName: "CoolCats",
    },
  ],
}
```

検索は、説明文、絵文字文字、セット名に対してファジーマッチングを行います。

**スレッディング付きの例:**

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "-1001234567890",
  fileId: "CAACAgIAAxkBAAI...",
  replyTo: 42,
  threadId: 123,
}
```

## ストリーミング（ドラフト）

Telegram は、エージェントが応答を生成している間に **ドラフトバブル** をストリーミングできます。
OpenClaw は Bot API の `sendMessageDraft`（実メッセージではありません）を使用し、
その後、通常のメッセージとして最終返信を送信します。

要件（Telegram Bot API 9.3+）:

- **トピック有効なプライベートチャット**（ボットのフォーラムトピックモード）。
- 受信メッセージに `message_thread_id`（プライベートトピックスレッド）が含まれていること。
- グループ／スーパーグループ／チャンネルではストリーミングは無視されます。

設定:

- `channels.telegram.streamMode: "off" | "partial" | "block"`（デフォルト: `partial`）
  - `partial`: 最新のストリーミングテキストでドラフトバブルを更新します。
  - `block`: 大きめのブロック（チャンク化）でドラフトバブルを更新します。
  - `off`: ドラフトストリーミングを無効化します。
- 任意（`streamMode: "block"` のみ）:
  - `channels.telegram.draftChunk: { minChars?, maxChars?, breakPreference? }`
    - 既定値: `minChars: 200`、`maxChars: 800`、`breakPreference: "paragraph"`（`channels.telegram.textChunkLimit` にクランプ）。

注記: ドラフトストリーミングは **ブロックストリーミング**（チャンネルメッセージ）とは別です。
ブロックストリーミングはデフォルトで無効で、ドラフト更新ではなく早期の Telegram メッセージを送信したい場合は `channels.telegram.blockStreaming: true` が必要です。

推論ストリーム（Telegram のみ）:

- `/reasoning stream` は、応答生成中に推論をドラフトバブルへストリーミングし、最終回答は推論なしで送信します。
- `channels.telegram.streamMode` が `off` の場合、推論ストリームは無効化されます。
  詳細: [ストリーミング + チャンク化](/concepts/streaming)。

## リトライポリシー

送信する Telegram API 呼び出しは、一時的なネットワーク／429 エラー時に指数バックオフとジッターで再試行されます。`channels.telegram.retry` で設定します。詳細は [リトライポリシー](/concepts/retry) を参照してください。

## エージェントツール（メッセージ + リアクション）

- ツール: `telegram` の `sendMessage` アクション（`to`、`content`、任意で `mediaUrl`、`replyToMessageId`、`messageThreadId`）。
- ツール: `telegram` の `react` アクション（`chatId`、`messageId`、`emoji`）。
- ツール: `telegram` の `deleteMessage` アクション（`chatId`、`messageId`）。
- リアクション削除のセマンティクス: [/tools/reactions](/tools/reactions) を参照してください。
- ツールゲーティング: `channels.telegram.actions.reactions`、`channels.telegram.actions.sendMessage`、`channels.telegram.actions.deleteMessage`（デフォルト: 有効）、および `channels.telegram.actions.sticker`（デフォルト: 無効）。

## リアクション通知

**リアクションの仕組み:**
Telegram のリアクションは、メッセージペイロードのプロパティではなく、**個別の `message_reaction` イベント**として届きます。ユーザーがリアクションを追加すると、OpenClaw は次を行います。

1. Telegram API から `message_reaction` 更新を受信
2. 形式 `"Telegram reaction added: {emoji} by {user} on msg {id}"` の **システムイベント** に変換
3. 通常のメッセージと **同じセッションキー** を使用してシステムイベントをキューに追加
4. 次のメッセージがその会話に到着した際、システムイベントがドレインされ、エージェントのコンテキストの先頭に追加

エージェントは、リアクションをメッセージのメタデータではなく、会話履歴内の **システム通知** として認識します。

**設定:**

- `channels.telegram.reactionNotifications`: 通知をトリガーするリアクションを制御
  - `"off"` — すべてのリアクションを無視
  - `"own"` — ユーザーがボットメッセージにリアクションしたときに通知（ベストエフォート／インメモリ）（デフォルト）
  - `"all"` — すべてのリアクションで通知

- `channels.telegram.reactionLevel`: エージェントのリアクション能力を制御
  - `"off"` — エージェントはリアクション不可
  - `"ack"` — ボットが確認リアクションを送信（処理中は 👀）（デフォルト）
  - `"minimal"` — エージェントは控えめにリアクション可能（目安: 5～10 往復に 1 回）
  - `"extensive"` — 適切な場合にエージェントが積極的にリアクション可能

**フォーラムグループ:** フォーラムグループ内のリアクションには `message_thread_id` が含まれ、`agent:main:telegram:group:{chatId}:topic:{threadId}` のようなセッションキーが使用されます。これにより、同一トピック内のリアクションとメッセージが一緒に扱われます。

**設定例:**

```json5
{
  channels: {
    telegram: {
      reactionNotifications: "all", // See all reactions
      reactionLevel: "minimal", // Agent can react sparingly
    },
  },
}
```

**要件:**

- Telegram ボットは `allowed_updates` で `message_reaction` を明示的に要求する必要があります（OpenClaw が自動設定）。
- webhook モードでは、リアクションは webhook の `allowed_updates` に含まれます。
- ポーリングモードでは、リアクションは `getUpdates` `allowed_updates` に含まれます。

## 配信先（CLI／cron）

- ターゲットとしてチャット ID（`123456789`）またはユーザー名（`@name`）を使用します。
- 例: `openclaw message send --channel telegram --target 123456789 --message "hi"`。

## トラブルシューティング

**グループでメンションなしのメッセージにボットが応答しない:**

- `channels.telegram.groups.*.requireMention=false` を設定している場合、Telegram Bot API の **プライバシーモード** を無効にする必要があります。
  - BotFather: `/setprivacy` → **Disable**（その後、ボットをグループから削除して再追加）
- `openclaw channels status` は、設定がメンションなしのグループメッセージを期待している場合に警告を表示します。
- `openclaw channels status --probe` は、明示的な数値グループ ID に対してメンバーシップを追加で確認できます（ワイルドカードの `"*"` ルールは監査できません）。
- クイックテスト: `/activation always`（セッションのみ。永続化には設定を使用）

**ボットがグループメッセージをまったく認識しない:**

- `channels.telegram.groups` が設定されている場合、グループは一覧に含まれるか `"*"` を使用する必要があります。
- @BotFather のプライバシー設定を確認 → 「Group Privacy」が **OFF** であること。
- ボットが実際にメンバーであることを確認（読み取り権限のない管理者のみになっていないか）。
- ゲートウェイログを確認: `openclaw logs --follow`（「skipping group message」を探します）。

**ボットがメンションには応答するが `/activation always` には応答しない:**

- `/activation` コマンドはセッション状態を更新しますが、設定には永続化されません。
- 永続化するには、`requireMention: false` とともにグループを `channels.telegram.groups` に追加します。

**`/status` のようなコマンドが動作しない:**

- Telegram のユーザー ID が（ペアリングまたは `channels.telegram.allowFrom` により）認可されていることを確認してください。
- `groupPolicy: "open"` があるグループでも、コマンドには認可が必要です。

**Node 22+ でロングポーリングが即座に中断される（プロキシ／カスタム fetch 使用時に多い）:**

- Node 22+ では `AbortSignal` インスタンスの扱いが厳格で、外部のシグナルが `fetch` 呼び出しを即座に中断することがあります。
- 中断シグナルを正規化する OpenClaw ビルドにアップグレードするか、アップグレード可能になるまで Node 20 でゲートウェイを実行してください。

**ボットが起動後に沈黙する（または `HttpError: Network request ... failed` がログに出る）:**

- 一部のホストは `api.telegram.org` を IPv6 に優先解決します。サーバーに IPv6 の送信経路がない場合、grammY が IPv6 専用リクエストでスタックすることがあります。
- 対処法: IPv6 の送信経路を有効化 **または** `api.telegram.org` に対して IPv4 解決を強制します（例: IPv4 の A レコードを使って `/etc/hosts` エントリを追加、または OS の DNS スタックで IPv4 を優先）。その後、ゲートウェイを再起動します。
- 簡易確認: `dig +short api.telegram.org A` と `dig +short api.telegram.org AAAA` で DNS の返り値を確認します。

## 設定リファレンス（Telegram）

完全な設定: [設定](/gateway/configuration)

プロバイダーオプション:

- `channels.telegram.enabled`: チャンネル起動の有効／無効。
- `channels.telegram.botToken`: ボットトークン（BotFather）。
- `channels.telegram.tokenFile`: ファイルパスからトークンを読み込み。
- `channels.telegram.dmPolicy`: `pairing | allowlist | open | disabled`（デフォルト: ペアリング）。
- `channels.telegram.allowFrom`: DM 許可リスト（ID／ユーザー名）。`open` には `"*"` が必要です。
- `channels.telegram.groupPolicy`: `open | allowlist | disabled`（デフォルト: 許可リスト）。
- `channels.telegram.groupAllowFrom`: グループ送信者許可リスト（ID／ユーザー名）。
- `channels.telegram.groups`: グループ別の既定値 + 許可リスト（グローバル既定は `"*"` を使用）。
  - `channels.telegram.groups.<id>.groupPolicy`: グループポリシー（`open | allowlist | disabled`）のグループ別上書き。
  - `channels.telegram.groups.<id>.requireMention`: メンションゲーティングの既定。
  - `channels.telegram.groups.<id>.skills`: skill フィルタ（省略 = すべての Skills、空 = なし）。
  - `channels.telegram.groups.<id>.allowFrom`: グループ送信者許可リストの上書き。
  - `channels.telegram.groups.<id>.systemPrompt`: グループ用の追加システムプロンプト。
  - `channels.telegram.groups.<id>.enabled`: `false` の場合にグループを無効化。
  - `channels.telegram.groups.<id>.topics.<threadId>.*`: トピック別上書き（グループと同じフィールド）。
  - `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy`: トピック別のグループポリシー上書き（`open | allowlist | disabled`）。
  - `channels.telegram.groups.<id>.topics.<threadId>.requireMention`: トピック別のメンションゲーティング上書き。
- `channels.telegram.capabilities.inlineButtons`: `off | dm | group | all | allowlist`（デフォルト: 許可リスト）。
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`: アカウント別上書き。
- `channels.telegram.replyToMode`: `off | first | all`（デフォルト: `first`）。
- `channels.telegram.textChunkLimit`: 送信チャンクサイズ（文字数）。
- `channels.telegram.chunkMode`: `length`（デフォルト）または `newline` を使用して、長さ分割の前に空行（段落境界）で分割。
- `channels.telegram.linkPreview`: 送信メッセージのリンクプレビュー切り替え（デフォルト: true）。
- `channels.telegram.streamMode`: `off | partial | block`（ドラフトストリーミング）。
- `channels.telegram.mediaMaxMb`: 送受信メディア上限（MB）。
- `channels.telegram.retry`: Telegram API 送信のリトライポリシー（回数、minDelayMs、maxDelayMs、jitter）。
- `channels.telegram.network.autoSelectFamily`: Node の autoSelectFamily を上書き（true=有効、false=無効）。Happy Eyeballs のタイムアウト回避のため、Node 22 ではデフォルト無効。
- `channels.telegram.proxy`: Bot API 呼び出し用のプロキシ URL（SOCKS／HTTP）。
- `channels.telegram.webhookUrl`: webhook モードを有効化（`channels.telegram.webhookSecret` が必要）。
- `channels.telegram.webhookSecret`: webhook シークレット（webhookUrl 設定時に必須）。
- `channels.telegram.webhookPath`: ローカル webhook パス（デフォルト `/telegram-webhook`）。
- `channels.telegram.actions.reactions`: Telegram ツールのリアクションをゲート。
- `channels.telegram.actions.sendMessage`: Telegram ツールのメッセージ送信をゲート。
- `channels.telegram.actions.deleteMessage`: Telegram ツールのメッセージ削除をゲート。
- `channels.telegram.actions.sticker`: Telegram ステッカーアクション（送信／検索）をゲート（デフォルト: false）。
- `channels.telegram.reactionNotifications`: `off | own | all` — システムイベントをトリガーするリアクションを制御（未設定時のデフォルト: `own`）。
- `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` — エージェントのリアクション能力を制御（未設定時のデフォルト: `minimal`）。

関連するグローバルオプション:

- `agents.list[].groupChat.mentionPatterns`（メンションゲーティングパターン）。
- `messages.groupChat.mentionPatterns`（グローバルフォールバック）。
- `commands.native`（デフォルトは `"auto"` → Telegram／Discord でオン、Slack でオフ）、`commands.text`、`commands.useAccessGroups`（コマンド挙動）。`channels.telegram.commands.native` で上書き可能。
- `messages.responsePrefix`、`messages.ackReaction`、`messages.ackReactionScope`、`messages.removeAckAfterReply`。
