---
summary: "Slackのセットアップとランタイム動作（Socket Mode + HTTP Events API）"
read_when:
  - Slackのセットアップやソケット/HTTPモードのデバッグ時
title: "Slack"
---

# Slack

ステータス: Slackアプリ統合によるDM + チャンネルでプロダクションレディ。デフォルトモードはSocket Mode。HTTP Events APIモードもサポートされています。

<CardGroup cols={3}>
  <Card title="ペアリング" icon="link" href="/channels/pairing">
    Slack DMはデフォルトでペアリングモードです。
  </Card>
  <Card title="スラッシュコマンド" icon="terminal" href="/tools/slash-commands">
    ネイティブコマンドの動作とコマンドカタログ。
  </Card>
  <Card title="チャンネルトラブルシューティング" icon="wrench" href="/channels/troubleshooting">
    クロスチャンネルの診断と修復プレイブック。
  </Card>
</CardGroup>

## クイックセットアップ

<Tabs>
  <Tab title="Socket Mode（デフォルト）">
    <Steps>
      <Step title="Slackアプリとトークンの作成">
        Slackアプリ設定で:

        - **Socket Mode**を有効化
        - `connections:write`スコープで**App Token**（`xapp-...`）を作成
        - アプリをインストールして**Bot Token**（`xoxb-...`）をコピー
      </Step>

      <Step title="OpenClawの設定">

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "socket",
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

        環境変数フォールバック（デフォルトアカウントのみ）:

```bash
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
```

      </Step>

      <Step title="アプリイベントのサブスクライブ">
        ボットイベントをサブスクライブします:

        - `app_mention`
        - `message.channels`、`message.groups`、`message.im`、`message.mpim`
        - `reaction_added`、`reaction_removed`
        - `member_joined_channel`、`member_left_channel`
        - `channel_rename`
        - `pin_added`、`pin_removed`

        また、DM用にApp Homeの**Messages Tab**を有効にします。
      </Step>

      <Step title="Gatewayを起動">

```bash
openclaw gateway
```

      </Step>
    </Steps>

  </Tab>

  <Tab title="HTTP Events APIモード">
    <Steps>
      <Step title="HTTP用のSlackアプリ設定">

        - モードをHTTPに設定（`channels.slack.mode="http"`）
        - Slackの**Signing Secret**をコピー
        - Event Subscriptions + Interactivity + Slash commandのRequest URLを同じウェブフックパスに設定（デフォルト`/slack/events`）

      </Step>

      <Step title="OpenClaw HTTPモードの設定">

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

      </Step>

      <Step title="マルチアカウントHTTPにはユニークなウェブフックパスを使用">
        アカウントごとのHTTPモードがサポートされています。

        登録が衝突しないように各アカウントに異なる`webhookPath`を付与してください。
      </Step>
    </Steps>

  </Tab>
</Tabs>

## トークンモデル

- Socket Modeには`botToken` + `appToken`が必要です。
- HTTPモードには`botToken` + `signingSecret`が必要です。
- 設定トークンは環境変数フォールバックをオーバーライドします。
- `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN`環境変数フォールバックはデフォルトアカウントにのみ適用されます。
- `userToken`（`xoxp-...`）は設定のみ（環境変数フォールバックなし）で、デフォルトは読み取り専用動作です（`userTokenReadOnly: true`）。
- オプション: 送信メッセージでアクティブエージェントのIDを使用したい場合は`chat:write.customize`を追加してください（カスタム`username`とアイコン）。`icon_emoji`は`:emoji_name:`構文を使用します。

<Tip>
アクション/ディレクトリ読み取りには、設定されている場合はユーザートークンが優先されます。書き込みにはボットトークンが優先されます。ユーザートークンによる書き込みは`userTokenReadOnly: false`でボットトークンが利用できない場合にのみ許可されます。
</Tip>

## アクセス制御とルーティング

<Tabs>
  <Tab title="DMポリシー">
    `channels.slack.dmPolicy`はDMアクセスを制御します（レガシー: `channels.slack.dm.policy`）:

    - `pairing`（デフォルト）
    - `allowlist`
    - `open`（`channels.slack.allowFrom`に`"*"`が必要。レガシー: `channels.slack.dm.allowFrom`）
    - `disabled`

    DMフラグ:

    - `dm.enabled`（デフォルトtrue）
    - `channels.slack.allowFrom`（推奨）
    - `dm.allowFrom`（レガシー）
    - `dm.groupEnabled`（グループDMはデフォルトfalse）
    - `dm.groupChannels`（オプションのMPIM許可リスト）

    マルチアカウント優先順位:

    - `channels.slack.accounts.default.allowFrom`は`default`アカウントにのみ適用されます。
    - 名前付きアカウントは自身の`allowFrom`が未設定の場合`channels.slack.allowFrom`を継承します。
    - 名前付きアカウントは`channels.slack.accounts.default.allowFrom`を継承しません。

    DMでのペアリングは`openclaw pairing approve slack <code>`を使用します。

  </Tab>

  <Tab title="チャンネルポリシー">
    `channels.slack.groupPolicy`はチャンネル処理を制御します:

    - `open`
    - `allowlist`
    - `disabled`

    チャンネル許可リストは`channels.slack.channels`の下にあります。

    ランタイムの注意: `channels.slack`が完全に欠けている（環境変数のみのセットアップ）場合、ランタイムは`groupPolicy="allowlist"`にフォールバックし警告を記録します（`channels.defaults.groupPolicy`が設定されていても）。

    名前/ID解決:

    - チャンネル許可リストエントリとDM許可リストエントリはトークンアクセスが許可する場合起動時に解決されます
    - 未解決のエントリは設定のまま保持されます
    - 受信認可マッチングはデフォルトでIDが優先されます。直接のユーザー名/スラグマッチングには`channels.slack.dangerouslyAllowNameMatching: true`が必要です

  </Tab>

  <Tab title="メンションとチャンネルユーザー">
    チャンネルメッセージはデフォルトでメンションゲートされます。

    メンションソース:

    - 明示的なアプリメンション（`<@botId>`）
    - メンション正規表現パターン（`agents.list[].groupChat.mentionPatterns`、フォールバック`messages.groupChat.mentionPatterns`）
    - 暗黙的なボットへの返信スレッド動作

    チャンネルごとの制御（`channels.slack.channels.<id|name>`）:

    - `requireMention`
    - `users`（許可リスト）
    - `allowBots`
    - `skills`
    - `systemPrompt`
    - `tools`、`toolsBySender`
    - `toolsBySender`キー形式: `id:`、`e164:`、`username:`、`name:`、または`"*"`ワイルドカード
      （レガシーのプレフィックスなしキーは`id:`のみにマッピングされます）

  </Tab>
</Tabs>

## コマンドとスラッシュ動作

- Slackのネイティブコマンド自動モードは**オフ**です（`commands.native: "auto"`はSlackネイティブコマンドを有効にしません）。
- `channels.slack.commands.native: true`（またはグローバルの`commands.native: true`）でネイティブSlackコマンドハンドラーを有効にします。
- ネイティブコマンドが有効な場合、Slackで対応するスラッシュコマンドを登録します（`/<command>`名前）。例外が1つあります:
  - statusコマンドには`/agentstatus`を登録してください（Slackが`/status`を予約しています）
- ネイティブコマンドが有効でない場合、`channels.slack.slashCommand`で単一の設定済みスラッシュコマンドを実行できます。
- ネイティブ引数メニューはレンダリング戦略を適応させます:
  - 5個以下のオプション: ボタンブロック
  - 6-100個のオプション: スタティックセレクトメニュー
  - 100個超のオプション: インタラクティビティオプションハンドラーが利用可能な場合、非同期オプションフィルタリング付きの外部セレクト
  - エンコードされたオプション値がSlackの制限を超える場合、フローはボタンにフォールバック
- 長いオプションペイロードの場合、スラッシュコマンド引数メニューは選択値をディスパッチする前に確認ダイアログを使用します。

デフォルトのスラッシュコマンド設定:

- `enabled: false`
- `name: "openclaw"`
- `sessionPrefix: "slack:slash"`
- `ephemeral: true`

スラッシュセッションは分離されたキーを使用します:

- `agent:<agentId>:slack:slash:<userId>`

ターゲット会話セッション（`CommandTargetSessionKey`）に対してコマンド実行をルーティングします。

## スレッディング、セッション、返信タグ

- DMは`direct`としてルーティング。チャンネルは`channel`。MPIMは`group`。
- デフォルトの`session.dmScope=main`では、Slack DMはエージェントメインセッションに統合されます。
- チャンネルセッション: `agent:<agentId>:slack:channel:<channelId>`。
- スレッド返信は該当する場合スレッドセッションサフィックス（`:thread:<threadTs>`）を作成できます。
- `channels.slack.thread.historyScope`のデフォルトは`thread`。`thread.inheritParent`のデフォルトは`false`。
- `channels.slack.thread.initialHistoryLimit`は新しいスレッドセッション開始時に取得される既存スレッドメッセージ数を制御します（デフォルト`20`、`0`で無効化）。

返信スレッディング制御:

- `channels.slack.replyToMode`: `off|first|all`（デフォルト`off`）
- `channels.slack.replyToModeByChatType`: `direct|group|channel`ごと
- ダイレクトチャットのレガシーフォールバック: `channels.slack.dm.replyToMode`

手動返信タグがサポートされています:

- `[[reply_to_current]]`
- `[[reply_to:<id>]]`

注意: `replyToMode="off"`はSlackでの**すべて**の返信スレッディングを無効にします（明示的な`[[reply_to_*]]`タグを含む）。これはTelegramとは異なり、Telegramでは明示的なタグは`"off"`モードでも有効です。この違いはプラットフォームのスレッディングモデルを反映しています: Slackスレッドはチャンネルからメッセージを隠しますが、Telegramの返信はメインチャットフローに表示されたままです。

## メディア、チャンキング、配信

<AccordionGroup>
  <Accordion title="受信添付ファイル">
    Slack添付ファイルはSlackホストのプライベートURL（トークン認証リクエストフロー）からダウンロードされ、フェッチ成功かつサイズ制限内の場合メディアストアに書き込まれます。

    ランタイムの受信サイズ上限は`channels.slack.mediaMaxMb`でオーバーライドされない限りデフォルト`20MB`です。

  </Accordion>

  <Accordion title="送信テキストとファイル">
    - テキストチャンクは`channels.slack.textChunkLimit`を使用（デフォルト4000）
    - `channels.slack.chunkMode="newline"`で段落優先分割を有効化
    - ファイル送信はSlackアップロードAPIを使用し、スレッド返信（`thread_ts`）を含めることができます
    - 送信メディア上限は設定されている場合`channels.slack.mediaMaxMb`に従います。それ以外はメディアパイプラインのMIMEタイプデフォルトを使用
  </Accordion>

  <Accordion title="配信ターゲット">
    推奨される明示的ターゲット:

    - `user:<id>` DM用
    - `channel:<id>` チャンネル用

    Slack DMはユーザーターゲットに送信する際にSlack Conversation API経由で開かれます。

  </Accordion>
</AccordionGroup>

## アクションとゲート

Slackアクションは`channels.slack.actions.*`で制御されます。

現在のSlackツーリングで利用可能なアクショングループ:

| グループ   | デフォルト |
| ---------- | --------- |
| messages   | 有効      |
| reactions  | 有効      |
| pins       | 有効      |
| memberInfo | 有効      |
| emojiList  | 有効      |

## イベントと運用動作

- メッセージの編集/削除/スレッドブロードキャストはシステムイベントにマッピングされます。
- リアクション追加/削除イベントはシステムイベントにマッピングされます。
- メンバーの参加/離脱、チャンネル作成/名前変更、ピン追加/削除イベントはシステムイベントにマッピングされます。
- アシスタントスレッドステータス更新（スレッドの「入力中...」インジケーター）は`assistant.threads.setStatus`を使用し、ボットスコープ`assistant:write`が必要です。
- `channel_id_changed`は`configWrites`が有効な場合、チャンネル設定キーを移行できます。
- チャンネルのトピック/目的メタデータは信頼されないコンテキストとして扱われ、ルーティングコンテキストに注入できます。
- ブロックアクションとモーダルインタラクションは構造化された`Slack interaction: ...`システムイベントをリッチペイロードフィールドで出力します:
  - ブロックアクション: 選択値、ラベル、ピッカー値、`workflow_*`メタデータ
  - モーダルの`view_submission`と`view_closed`イベント（ルーティングされたチャンネルメタデータとフォーム入力付き）

## 確認リアクション

`ackReaction`はOpenClawが受信メッセージを処理中に確認絵文字を送信します。

解決順序:

- `channels.slack.accounts.<accountId>.ackReaction`
- `channels.slack.ackReaction`
- `messages.ackReaction`
- エージェントIDの絵文字フォールバック（`agents.list[].identity.emoji`、なければ"👀"）

注意:

- Slackはショートコード（例: `"eyes"`）を期待します。
- `""`でチャンネルまたはアカウントのリアクションを無効化します。

## マニフェストとスコープチェックリスト

<AccordionGroup>
  <Accordion title="Slackアプリマニフェスト例">

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "im:history",
        "mpim:history",
        "users:read",
        "app_mentions:read",
        "assistant:write",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

  </Accordion>

  <Accordion title="オプションのユーザートークンスコープ（読み取り操作）">
    `channels.slack.userToken`を設定する場合、一般的な読み取りスコープ:

    - `channels:history`、`groups:history`、`im:history`、`mpim:history`
    - `channels:read`、`groups:read`、`im:read`、`mpim:read`
    - `users:read`
    - `reactions:read`
    - `pins:read`
    - `emoji:read`
    - `search:read`（Slack検索読み取りに依存する場合）

  </Accordion>
</AccordionGroup>

## トラブルシューティング

<AccordionGroup>
  <Accordion title="チャンネルで返信がない">
    以下の順序で確認:

    - `groupPolicy`
    - チャンネル許可リスト（`channels.slack.channels`）
    - `requireMention`
    - チャンネルごとの`users`許可リスト

    便利なコマンド:

```bash
openclaw channels status --probe
openclaw logs --follow
openclaw doctor
```

  </Accordion>

  <Accordion title="DMメッセージが無視される">
    確認:

    - `channels.slack.dm.enabled`
    - `channels.slack.dmPolicy`（またはレガシーの`channels.slack.dm.policy`）
    - ペアリング承認 / 許可リストエントリ

```bash
openclaw pairing list slack
```

  </Accordion>

  <Accordion title="Socket Modeが接続しない">
    Slackアプリ設定でボット + アプリトークンとSocket Mode有効化を検証してください。
  </Accordion>

  <Accordion title="HTTPモードがイベントを受信しない">
    検証:

    - Signing Secret
    - ウェブフックパス
    - Slack Request URL（Events + Interactivity + Slash Commands）
    - HTTPアカウントごとのユニークな`webhookPath`

  </Accordion>

  <Accordion title="ネイティブ/スラッシュコマンドが動作しない">
    意図した設定を確認:

    - ネイティブコマンドモード（`channels.slack.commands.native: true`）でSlackに対応するスラッシュコマンドを登録
    - または単一スラッシュコマンドモード（`channels.slack.slashCommand.enabled: true`）

    `commands.useAccessGroups`とチャンネル/ユーザー許可リストも確認してください。

  </Accordion>
</AccordionGroup>

## テキストストリーミング

OpenClawはAgents and AI Apps APIを介したSlackネイティブテキストストリーミングをサポートしています。

`channels.slack.streaming`はライブプレビュー動作を制御します:

- `off`: ライブプレビューストリーミングを無効化。
- `partial`（デフォルト）: プレビューテキストを最新の部分出力で置換。
- `block`: チャンクされたプレビュー更新を追加。
- `progress`: 生成中はプログレスステータステキストを表示し、最終テキストを送信。

`channels.slack.nativeStreaming`は`streaming`が`partial`の場合にSlackのネイティブストリーミングAPI（`chat.startStream` / `chat.appendStream` / `chat.stopStream`）を制御します（デフォルト: `true`）。

ネイティブSlackストリーミングを無効化（ドラフトプレビュー動作を維持）:

```yaml
channels:
  slack:
    streaming: partial
    nativeStreaming: false
```

レガシーキー:

- `channels.slack.streamMode`（`replace | status_final | append`）は`channels.slack.streaming`に自動移行されます。
- ブーリアンの`channels.slack.streaming`は`channels.slack.nativeStreaming`に自動移行されます。

### 要件

1. Slackアプリ設定で**Agents and AI Apps**を有効にします。
2. アプリが`assistant:write`スコープを持っていることを確認します。
3. そのメッセージに対して返信スレッドが利用可能である必要があります。スレッド選択は`replyToMode`に従います。

### 動作

- 最初のテキストチャンクがストリームを開始します（`chat.startStream`）。
- 後続のテキストチャンクが同じストリームに追加されます（`chat.appendStream`）。
- 返信の終了でストリームがファイナライズされます（`chat.stopStream`）。
- メディアおよび非テキストペイロードは通常の配信にフォールバックします。
- 返信途中でストリーミングが失敗した場合、OpenClawは残りのペイロードに対して通常の配信にフォールバックします。

## 設定リファレンスポインター

プライマリリファレンス:

- [設定リファレンス - Slack](/gateway/configuration-reference#slack)

  重要なSlackフィールド:
  - モード/認証: `mode`、`botToken`、`appToken`、`signingSecret`、`webhookPath`、`accounts.*`
  - DMアクセス: `dm.enabled`、`dmPolicy`、`allowFrom`（レガシー: `dm.policy`、`dm.allowFrom`）、`dm.groupEnabled`、`dm.groupChannels`
  - 互換性トグル: `dangerouslyAllowNameMatching`（ブレイクグラス。必要でない限りオフに維持）
  - チャンネルアクセス: `groupPolicy`、`channels.*`、`channels.*.users`、`channels.*.requireMention`
  - スレッディング/履歴: `replyToMode`、`replyToModeByChatType`、`thread.*`、`historyLimit`、`dmHistoryLimit`、`dms.*.historyLimit`
  - 配信: `textChunkLimit`、`chunkMode`、`mediaMaxMb`、`streaming`、`nativeStreaming`
  - 運用/機能: `configWrites`、`commands.native`、`slashCommand.*`、`actions.*`、`userToken`、`userTokenReadOnly`

## 関連ドキュメント

- [ペアリング](/channels/pairing)
- [チャンネルルーティング](/channels/channel-routing)
- [トラブルシューティング](/channels/troubleshooting)
- [設定](/gateway/configuration)
- [スラッシュコマンド](/tools/slash-commands)
