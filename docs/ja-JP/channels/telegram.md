---
summary: "Telegramボットのサポート状況、機能、設定"
read_when:
  - Telegramの機能やウェブフックを作業するとき
title: "Telegram"
---

# Telegram（Bot API）

ステータス: grammY経由のボットDM + グループでプロダクションレディ。デフォルトモードはロングポーリング。ウェブフックモードはオプションです。

<CardGroup cols={3}>
  <Card title="ペアリング" icon="link" href="/channels/pairing">
    TelegramのデフォルトDMポリシーはペアリングです。
  </Card>
  <Card title="チャンネルトラブルシューティング" icon="wrench" href="/channels/troubleshooting">
    クロスチャンネルの診断と修復プレイブック。
  </Card>
  <Card title="Gateway設定" icon="settings" href="/gateway/configuration">
    完全なチャンネル設定パターンと例。
  </Card>
</CardGroup>

## クイックセットアップ

<Steps>
  <Step title="BotFatherでボットトークンを作成">
    Telegramを開き、**@BotFather**とチャットします（ハンドルが正確に`@BotFather`であることを確認してください）。

    `/newbot`を実行し、プロンプトに従ってトークンを保存します。

  </Step>

  <Step title="トークンとDMポリシーを設定">

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

    環境変数フォールバック: `TELEGRAM_BOT_TOKEN=...`（デフォルトアカウントのみ）。
    Telegramは`openclaw channels login telegram`を**使用しません**。設定/環境変数でトークンを設定し、Gatewayを起動してください。

  </Step>

  <Step title="Gatewayを起動し最初のDMを承認">

```bash
openclaw gateway
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

    ペアリングコードは1時間後に期限切れになります。

  </Step>

  <Step title="ボットをグループに追加">
    ボットをグループに追加し、アクセスモデルに合わせて`channels.telegram.groups`と`groupPolicy`を設定します。
  </Step>
</Steps>

<Note>
トークン解決順序はアカウント対応です。実際には設定値が環境変数フォールバックよりも優先され、`TELEGRAM_BOT_TOKEN`はデフォルトアカウントにのみ適用されます。
</Note>

## Telegram側の設定

<AccordionGroup>
  <Accordion title="プライバシーモードとグループの可視性">
    Telegramボットはデフォルトで**プライバシーモード**になっており、受信するグループメッセージが制限されます。

    ボットがすべてのグループメッセージを見る必要がある場合:

    - `/setprivacy`でプライバシーモードを無効にするか、
    - ボットをグループ管理者にします。

    プライバシーモードを切り替えた場合、Telegramが変更を適用するように各グループでボットを削除 + 再追加してください。

  </Accordion>

  <Accordion title="グループ権限">
    管理者ステータスはTelegramグループ設定で制御されます。

    管理者ボットはすべてのグループメッセージを受信するため、常時オンのグループ動作に便利です。

  </Accordion>

  <Accordion title="便利なBotFatherトグル">

    - `/setjoingroups`でグループ追加の許可/拒否
    - `/setprivacy`でグループの可視性動作

  </Accordion>
</AccordionGroup>

## アクセス制御とアクティベーション

<Tabs>
  <Tab title="DMポリシー">
    `channels.telegram.dmPolicy`はダイレクトメッセージアクセスを制御します:

    - `pairing`（デフォルト）
    - `allowlist`（`allowFrom`に少なくとも1つの送信者IDが必要）
    - `open`（`allowFrom`に`"*"`が必要）
    - `disabled`

    `channels.telegram.allowFrom`は数値のTelegramユーザーIDを受け入れます。`telegram:` / `tg:`プレフィックスは受け入れられ正規化されます。
    `dmPolicy: "allowlist"`で空の`allowFrom`はすべてのDMをブロックし、設定バリデーションで拒否されます。
    オンボーディングウィザードは`@username`入力を受け入れ、数値IDに解決します。
    アップグレード後に設定に`@username`許可リストエントリがある場合、`openclaw doctor --fix`を実行して解決してください（ベストエフォート。Telegramボットトークンが必要）。
    以前ペアリングストア許可リストファイルに依存していた場合、`openclaw doctor --fix`は許可リストフローでエントリを`channels.telegram.allowFrom`にリカバリできます（例: `dmPolicy: "allowlist"`に明示的なIDがまだない場合）。

    ### TelegramユーザーIDの確認方法

    より安全な方法（サードパーティボット不要）:

    1. ボットにDMを送信します。
    2. `openclaw logs --follow`を実行します。
    3. `from.id`を読み取ります。

    公式Bot APIメソッド:

```bash
curl "https://api.telegram.org/bot<bot_token>/getUpdates"
```

    サードパーティ方法（プライバシーが低い）: `@userinfobot`または`@getidsbot`。

  </Tab>

  <Tab title="グループポリシーと許可リスト">
    2つの制御が一緒に適用されます:

    1. **どのグループが許可されるか**（`channels.telegram.groups`）
       - `groups`設定なし:
         - `groupPolicy: "open"`の場合: どのグループもグループIDチェックを通過
         - `groupPolicy: "allowlist"`（デフォルト）の場合: `groups`エントリ（または`"*"`）を追加するまでグループはブロック
       - `groups`設定あり: 許可リストとして機能（明示的なIDまたは`"*"`）

    2. **グループで許可される送信者**（`channels.telegram.groupPolicy`）
       - `open`
       - `allowlist`（デフォルト）
       - `disabled`

    `groupAllowFrom`はグループ送信者フィルタリングに使用されます。未設定の場合、Telegramは`allowFrom`にフォールバックします。
    `groupAllowFrom`エントリは数値のTelegramユーザーIDであるべきです（`telegram:` / `tg:`プレフィックスは正規化されます）。
    非数値エントリは送信者認可で無視されます。
    セキュリティ境界（`2026.2.25+`）: グループ送信者認可はDMペアリングストア承認を**継承しません**。
    ペアリングはDM専用のままです。グループには`groupAllowFrom`またはグループ/トピックごとの`allowFrom`を設定してください。
    ランタイムの注意: `channels.telegram`が完全に欠けている場合、`channels.defaults.groupPolicy`が明示的に設定されていない限り、ランタイムはフェイルクローズドの`groupPolicy="allowlist"`にデフォルトします。

    例: 1つの特定グループで任意のメンバーを許可:

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

  </Tab>

  <Tab title="メンション動作">
    グループ返信にはデフォルトでメンションが必要です。

    メンションの取得元:

    - ネイティブの`@botusername`メンション、または
    - メンションパターン:
      - `agents.list[].groupChat.mentionPatterns`
      - `messages.groupChat.mentionPatterns`

    セッションレベルのコマンドトグル:

    - `/activation always`
    - `/activation mention`

    これらはセッション状態のみを更新します。永続化には設定を使用してください。

    永続的な設定例:

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: false },
      },
    },
  },
}
```

    グループチャットIDの取得:

    - グループメッセージを`@userinfobot` / `@getidsbot`に転送
    - または`openclaw logs --follow`から`chat.id`を読み取る
    - またはBot APIの`getUpdates`を確認

  </Tab>
</Tabs>

## ランタイム動作

- TelegramはGatewayプロセスが管理します。
- ルーティングは決定論的です: Telegram受信はTelegramに返信されます（モデルはチャンネルを選択しません）。
- 受信メッセージは返信メタデータとメディアプレースホルダー付きの共有チャンネルエンベロープに正規化されます。
- グループセッションはグループIDで分離されます。フォーラムトピックは`:topic:<threadId>`を追加してトピックを分離します。
- DMメッセージは`message_thread_id`を持つことができます。OpenClawはスレッド対応のセッションキーでルーティングし、返信にスレッドIDを保持します。
- ロングポーリングはチャット/スレッドごとのシーケンシングでgrammY runnerを使用します。全体のランナーシンク並行性は`agents.defaults.maxConcurrent`を使用します。
- Telegram Bot APIには既読レシートサポートがありません（`sendReadReceipts`は適用されません）。

## 機能リファレンス

<AccordionGroup>
  <Accordion title="ライブストリームプレビュー（メッセージ編集）">
    OpenClawは一時的なTelegramメッセージを送信し、テキストが到着するにつれて編集することで部分的な返信をストリーミングできます。

    要件:

    - `channels.telegram.streaming`は`off | partial | block | progress`（デフォルト: `off`）
    - `progress`はTelegramでは`partial`にマッピング（クロスチャンネル命名との互換性）
    - レガシーの`channels.telegram.streamMode`とブーリアンの`streaming`値は自動マッピングされます

    ダイレクトチャットとグループ/トピックの両方で動作します。

    テキストのみの返信では、OpenClawは同じプレビューメッセージを維持し、最終編集をインプレースで実行します（2番目のメッセージなし）。

    複雑な返信（例: メディアペイロード）では、OpenClawは通常の最終配信にフォールバックし、プレビューメッセージをクリーンアップします。

    プレビューストリーミングはブロックストリーミングとは別です。Telegramでブロックストリーミングが明示的に有効な場合、OpenClawはダブルストリーミングを避けるためプレビューストリームをスキップします。

    Telegram固有のリーズニングストリーム:

    - `/reasoning stream`は生成中にリーズニングをライブプレビューに送信します
    - 最終回答はリーズニングテキストなしで送信されます

  </Accordion>

  <Accordion title="フォーマットとHTMLフォールバック">
    送信テキストはTelegramの`parse_mode: "HTML"`を使用します。

    - Markdown風テキストはTelegramセーフHTMLにレンダリングされます。
    - 生のモデルHTMLはTelegramパースエラーを減らすためエスケープされます。
    - TelegramがパースされたHTMLを拒否した場合、OpenClawはプレーンテキストとしてリトライします。

    リンクプレビューはデフォルトで有効であり、`channels.telegram.linkPreview: false`で無効化できます。

  </Accordion>

  <Accordion title="ネイティブコマンドとカスタムコマンド">
    Telegramコマンドメニュー登録は起動時に`setMyCommands`で処理されます。

    ネイティブコマンドのデフォルト:

    - `commands.native: "auto"`はTelegramのネイティブコマンドを有効にします

    カスタムコマンドメニューエントリの追加:

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

    ルール:

    - 名前は正規化されます（先頭の`/`を除去、小文字化）
    - 有効なパターン: `a-z`、`0-9`、`_`、長さ`1..32`
    - カスタムコマンドはネイティブコマンドをオーバーライドできません
    - 競合/重複はスキップされログに記録されます

    注意:

    - カスタムコマンドはメニューエントリのみです。自動的に動作を実装しません
    - プラグイン/スキルコマンドはTelegramメニューに表示されなくてもタイプすれば動作します

    ネイティブコマンドが無効の場合、ビルトインは削除されます。カスタム/プラグインコマンドは設定されていれば登録される場合があります。

    よくあるセットアップ失敗:

    - `setMyCommands failed`は通常`api.telegram.org`への送信DNS/HTTPSがブロックされていることを意味します。

    ### デバイスペアリングコマンド（`device-pair`プラグイン）

    `device-pair`プラグインがインストールされている場合:

    1. `/pair`でセットアップコードを生成
    2. iOSアプリにコードを貼り付け
    3. `/pair approve`で最新の保留リクエストを承認

    詳細: [ペアリング](/channels/pairing#pair-via-telegram-recommended-for-ios)。

  </Accordion>

  <Accordion title="インラインボタン">
    インラインキーボードのスコープを設定:

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

    アカウントごとのオーバーライド:

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

    - `off`
    - `dm`
    - `group`
    - `all`
    - `allowlist`（デフォルト）

    レガシーの`capabilities: ["inlineButtons"]`は`inlineButtons: "all"`にマッピングされます。

    メッセージアクションの例:

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

    コールバッククリックはエージェントにテキストとして渡されます:
    `callback_data: <value>`

  </Accordion>

  <Accordion title="エージェントと自動化のためのTelegramメッセージアクション">
    Telegramツールアクションには以下が含まれます:

    - `sendMessage`（`to`、`content`、オプションの`mediaUrl`、`replyToMessageId`、`messageThreadId`）
    - `react`（`chatId`、`messageId`、`emoji`）
    - `deleteMessage`（`chatId`、`messageId`）
    - `editMessage`（`chatId`、`messageId`、`content`）
    - `createForumTopic`（`chatId`、`name`、オプションの`iconColor`、`iconCustomEmojiId`）

    チャンネルメッセージアクションはエルゴノミックエイリアスを公開します（`send`、`react`、`delete`、`edit`、`sticker`、`sticker-search`、`topic-create`）。

    ゲーティング制御:

    - `channels.telegram.actions.sendMessage`
    - `channels.telegram.actions.deleteMessage`
    - `channels.telegram.actions.reactions`
    - `channels.telegram.actions.sticker`（デフォルト: 無効）

    注意: `edit`と`topic-create`は現在デフォルトで有効であり、別の`channels.telegram.actions.*`トグルはありません。

    リアクション削除のセマンティクス: [/tools/reactions](/tools/reactions)

  </Accordion>

  <Accordion title="返信スレッディングタグ">
    Telegramは生成出力での明示的な返信スレッディングタグをサポートします:

    - `[[reply_to_current]]`はトリガーメッセージに返信
    - `[[reply_to:<id>]]`は特定のTelegramメッセージIDに返信

    `channels.telegram.replyToMode`は処理を制御します:

    - `off`（デフォルト）
    - `first`
    - `all`

    注意: `off`は暗黙的な返信スレッディングを無効にします。明示的な`[[reply_to_*]]`タグは引き続き有効です。

  </Accordion>

  <Accordion title="フォーラムトピックとスレッド動作">
    フォーラムスーパーグループ:

    - トピックセッションキーは`:topic:<threadId>`を追加
    - 返信とタイピングはトピックスレッドをターゲット
    - トピック設定パス:
      `channels.telegram.groups.<chatId>.topics.<threadId>`

    一般トピック（`threadId=1`）の特殊ケース:

    - メッセージ送信は`message_thread_id`を省略（Telegramは`sendMessage(...thread_id=1)`を拒否）
    - タイピングアクションは引き続き`message_thread_id`を含む

    トピック継承: トピックエントリはオーバーライドされない限りグループ設定を継承します（`requireMention`、`allowFrom`、`skills`、`systemPrompt`、`enabled`、`groupPolicy`）。

    テンプレートコンテキストに含まれるもの:

    - `MessageThreadId`
    - `IsForum`

    DMスレッド動作:

    - `message_thread_id`付きのプライベートチャットはDMルーティングを維持しますが、スレッド対応のセッションキー/返信ターゲットを使用します。

  </Accordion>

  <Accordion title="音声、動画、スタンプ">
    ### 音声メッセージ

    Telegramはボイスノートとオーディオファイルを区別します。

    - デフォルト: オーディオファイル動作
    - エージェント返信でタグ`[[audio_as_voice]]`を使用してボイスノート送信を強制

    メッセージアクションの例:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/voice.ogg",
  asVoice: true,
}
```

    ### 動画メッセージ

    Telegramはビデオファイルとビデオノートを区別します。

    メッセージアクションの例:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/video.mp4",
  asVideoNote: true,
}
```

    ビデオノートはキャプションをサポートしません。提供されたメッセージテキストは別途送信されます。

    ### スタンプ

    受信スタンプの処理:

    - 静的WEBP: ダウンロードして処理（プレースホルダー`<media:sticker>`）
    - アニメーションTGS: スキップ
    - ビデオWEBM: スキップ

    スタンプコンテキストフィールド:

    - `Sticker.emoji`
    - `Sticker.setName`
    - `Sticker.fileId`
    - `Sticker.fileUniqueId`
    - `Sticker.cachedDescription`

    スタンプキャッシュファイル:

    - `~/.openclaw/telegram/sticker-cache.json`

    スタンプは1回説明され（可能な場合）、繰り返しのビジョンコールを減らすためにキャッシュされます。

    スタンプアクションの有効化:

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

    スタンプ送信アクション:

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "123456789",
  fileId: "CAACAgIAAxkBAAI...",
}
```

    キャッシュされたスタンプの検索:

```json5
{
  action: "sticker-search",
  channel: "telegram",
  query: "cat waving",
  limit: 5,
}
```

  </Accordion>

  <Accordion title="リアクション通知">
    Telegramリアクションは`message_reaction`アップデートとして到着します（メッセージペイロードとは別）。

    有効な場合、OpenClawは以下のようなシステムイベントをキューに入れます:

    - `Telegram reaction added: 👍 by Alice (@alice) on msg 42`

    設定:

    - `channels.telegram.reactionNotifications`: `off | own | all`（デフォルト: `own`）
    - `channels.telegram.reactionLevel`: `off | ack | minimal | extensive`（デフォルト: `minimal`）

    注意:

    - `own`はボット送信メッセージへのユーザーリアクションのみ（送信メッセージキャッシュ経由のベストエフォート）。
    - リアクションイベントはTelegramアクセス制御（`dmPolicy`、`allowFrom`、`groupPolicy`、`groupAllowFrom`）を引き続き遵守します。未認可の送信者はドロップされます。
    - Telegramはリアクション更新にスレッドIDを提供しません。
      - 非フォーラムグループはグループチャットセッションにルーティング
      - フォーラムグループはグループの一般トピックセッション（`:topic:1`）にルーティング（正確な発信トピックではない）

    ポーリング/ウェブフックの`allowed_updates`には自動的に`message_reaction`が含まれます。

  </Accordion>

  <Accordion title="確認リアクション">
    `ackReaction`はOpenClawが受信メッセージを処理中に確認絵文字を送信します。

    解決順序:

    - `channels.telegram.accounts.<accountId>.ackReaction`
    - `channels.telegram.ackReaction`
    - `messages.ackReaction`
    - エージェントIDの絵文字フォールバック（`agents.list[].identity.emoji`、なければ"👀"）

    注意:

    - TelegramはUnicode絵文字を期待します（例: "👀"）。
    - `""`でチャンネルまたはアカウントのリアクションを無効化します。

  </Accordion>

  <Accordion title="Telegramイベントとコマンドからの設定書き込み">
    チャンネル設定書き込みはデフォルトで有効です（`configWrites !== false`）。

    Telegramトリガーの書き込みには以下が含まれます:

    - グループ移行イベント（`migrate_to_chat_id`）で`channels.telegram.groups`を更新
    - `/config set`と`/config unset`（コマンド有効化が必要）

    無効化:

```json5
{
  channels: {
    telegram: {
      configWrites: false,
    },
  },
}
```

  </Accordion>

  <Accordion title="ロングポーリング vs ウェブフック">
    デフォルト: ロングポーリング。

    ウェブフックモード:

    - `channels.telegram.webhookUrl`を設定
    - `channels.telegram.webhookSecret`を設定（ウェブフックURL設定時に必要）
    - オプションの`channels.telegram.webhookPath`（デフォルト`/telegram-webhook`）
    - オプションの`channels.telegram.webhookHost`（デフォルト`127.0.0.1`）
    - オプションの`channels.telegram.webhookPort`（デフォルト`8787`）

    ウェブフックモードのデフォルトローカルリスナーは`127.0.0.1:8787`にバインドします。

    パブリックエンドポイントが異なる場合、リバースプロキシを前に配置し、`webhookUrl`をパブリックURLにポイントしてください。
    意図的に外部イングレスが必要な場合は`webhookHost`を設定してください（例: `0.0.0.0`）。

  </Accordion>

  <Accordion title="制限、リトライ、CLIターゲット">
    - `channels.telegram.textChunkLimit`のデフォルトは4000。
    - `channels.telegram.chunkMode="newline"`は長さ分割の前に段落境界（空行）を優先します。
    - `channels.telegram.mediaMaxMb`（デフォルト5）は受信Telegramメディアのダウンロード/処理サイズを上限とします。
    - `channels.telegram.timeoutSeconds`はTelegram APIクライアントタイムアウトをオーバーライドします（未設定時はgrammYデフォルトが適用）。
    - グループコンテキスト履歴は`channels.telegram.historyLimit`または`messages.groupChat.historyLimit`（デフォルト50）を使用。`0`で無効化。
    - DM履歴制御:
      - `channels.telegram.dmHistoryLimit`
      - `channels.telegram.dms["<user_id>"].historyLimit`
    - `channels.telegram.retry`設定はリカバリ可能な送信APIエラーに対してTelegram送信ヘルパー（CLI/ツール/アクション）に適用されます。

    CLI送信ターゲットは数値チャットIDまたはユーザー名を指定できます:

```bash
openclaw message send --channel telegram --target 123456789 --message "hi"
openclaw message send --channel telegram --target @name --message "hi"
```

  </Accordion>
</AccordionGroup>

## トラブルシューティング

<AccordionGroup>
  <Accordion title="ボットが非メンショングループメッセージに応答しない">

    - `requireMention=false`の場合、Telegramプライバシーモードがフル可視性を許可する必要があります。
      - BotFather: `/setprivacy` -> Disable
      - その後、グループでボットを削除 + 再追加
    - `openclaw channels status`は設定がメンションなしグループメッセージを期待する場合に警告します。
    - `openclaw channels status --probe`は明示的な数値グループIDをチェックできます。ワイルドカード`"*"`はメンバーシッププローブできません。
    - クイックセッションテスト: `/activation always`。

  </Accordion>

  <Accordion title="ボットがグループメッセージをまったく見ていない">

    - `channels.telegram.groups`が存在する場合、グループがリストされている（または`"*"`を含む）必要があります
    - グループ内のボットメンバーシップを確認
    - ログを確認: `openclaw logs --follow`でスキップ理由を確認

  </Accordion>

  <Accordion title="コマンドが部分的にまたはまったく動作しない">

    - 送信者IDを認可してください（ペアリングおよび/または数値の`allowFrom`）
    - グループポリシーが`open`の場合でもコマンド認可は適用されます
    - `setMyCommands failed`は通常`api.telegram.org`へのDNS/HTTPS到達可能性の問題を示します

  </Accordion>

  <Accordion title="ポーリングまたはネットワークの不安定性">

    - Node 22+ + カスタムfetch/proxyはAbortSignalタイプの不一致により即時中止動作をトリガーする可能性があります。
    - 一部のホストは`api.telegram.org`をIPv6で先に解決します。IPv6の送信が壊れていると断続的なTelegram API障害が発生する可能性があります。
    - ログに`TypeError: fetch failed`または`Network request for 'getUpdates' failed!`が含まれる場合、OpenClawはこれらをリカバリ可能なネットワークエラーとしてリトライします。
    - 不安定な直接送信/TLSを持つVPSホストでは、Telegram API呼び出しを`channels.telegram.proxy`経由でルーティングします:

```yaml
channels:
  telegram:
    proxy: socks5://user:pass@proxy-host:1080
```

    - Node 22+は`autoSelectFamily=true`（WSL2を除く）と`dnsResultOrder=ipv4first`をデフォルトとします。
    - ホストがWSL2であるか、IPv4のみの動作がより良く動作する場合、ファミリー選択を強制します:

```yaml
channels:
  telegram:
    network:
      autoSelectFamily: false
```

    - 環境変数オーバーライド（一時的）:
      - `OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY=1`
      - `OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY=1`
      - `OPENCLAW_TELEGRAM_DNS_RESULT_ORDER=ipv4first`
    - DNS応答の検証:

```bash
dig +short api.telegram.org A
dig +short api.telegram.org AAAA
```

  </Accordion>
</AccordionGroup>

詳細: [チャンネルトラブルシューティング](/channels/troubleshooting)。

## Telegram設定リファレンスポインター

プライマリリファレンス:

- `channels.telegram.enabled`: チャンネル起動の有効/無効。
- `channels.telegram.botToken`: ボットトークン（BotFather）。
- `channels.telegram.tokenFile`: ファイルパスからトークンを読み取り。
- `channels.telegram.dmPolicy`: `pairing | allowlist | open | disabled`（デフォルト: pairing）。
- `channels.telegram.allowFrom`: DM許可リスト（数値TelegramユーザーID）。`allowlist`には少なくとも1つの送信者IDが必要。`open`には`"*"`が必要。`openclaw doctor --fix`はレガシーの`@username`エントリをIDに解決でき、許可リスト移行フローでペアリングストアファイルからエントリをリカバリできます。
- `channels.telegram.defaultTo`: 明示的な`--reply-to`が提供されない場合にCLI `--deliver`で使用されるデフォルトTelegramターゲット。
- `channels.telegram.groupPolicy`: `open | allowlist | disabled`（デフォルト: allowlist）。
- `channels.telegram.groupAllowFrom`: グループ送信者許可リスト（数値TelegramユーザーID）。`openclaw doctor --fix`はレガシーの`@username`エントリをIDに解決できます。非数値エントリは認証時に無視されます。グループ認証はDMペアリングストアフォールバックを使用しません（`2026.2.25+`）。
- マルチアカウント優先順位:
  - `channels.telegram.accounts.default.allowFrom`と`channels.telegram.accounts.default.groupAllowFrom`は`default`アカウントにのみ適用されます。
  - 名前付きアカウントはアカウントレベルの値が未設定の場合`channels.telegram.allowFrom`と`channels.telegram.groupAllowFrom`を継承します。
  - 名前付きアカウントは`channels.telegram.accounts.default.allowFrom` / `groupAllowFrom`を継承しません。
- `channels.telegram.groups`: グループごとのデフォルト + 許可リスト（グローバルデフォルトには`"*"`を使用）。
  - `channels.telegram.groups.<id>.groupPolicy`: グループごとのgroupPolicyオーバーライド（`open | allowlist | disabled`）。
  - `channels.telegram.groups.<id>.requireMention`: メンションゲーティングデフォルト。
  - `channels.telegram.groups.<id>.skills`: スキルフィルター（省略 = すべてのスキル、空 = なし）。
  - `channels.telegram.groups.<id>.allowFrom`: グループごとの送信者許可リストオーバーライド。
  - `channels.telegram.groups.<id>.systemPrompt`: グループの追加システムプロンプト。
  - `channels.telegram.groups.<id>.enabled`: `false`でグループを無効化。
  - `channels.telegram.groups.<id>.topics.<threadId>.*`: トピックごとのオーバーライド（グループと同じフィールド）。
  - `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy`: トピックごとのgroupPolicyオーバーライド。
  - `channels.telegram.groups.<id>.topics.<threadId>.requireMention`: トピックごとのメンションゲーティングオーバーライド。
- `channels.telegram.capabilities.inlineButtons`: `off | dm | group | all | allowlist`（デフォルト: allowlist）。
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`: アカウントごとのオーバーライド。
- `channels.telegram.commands.nativeSkills`: Telegramネイティブスキルコマンドの有効/無効。
- `channels.telegram.replyToMode`: `off | first | all`（デフォルト: `off`）。
- `channels.telegram.textChunkLimit`: 送信チャンクサイズ（文字数）。
- `channels.telegram.chunkMode`: `length`（デフォルト）または`newline`で空行（段落境界）で分割後に長さチャンキング。
- `channels.telegram.linkPreview`: 送信メッセージのリンクプレビュー切替（デフォルト: true）。
- `channels.telegram.streaming`: `off | partial | block | progress`（ライブストリームプレビュー。デフォルト: `off`。`progress`は`partial`にマッピング。`block`はレガシープレビューモード互換）。
- `channels.telegram.mediaMaxMb`: 受信Telegramメディアダウンロード/処理上限（MB）。
- `channels.telegram.retry`: リカバリ可能な送信APIエラーに対するTelegram送信ヘルパーのリトライポリシー（attempts、minDelayMs、maxDelayMs、jitter）。
- `channels.telegram.network.autoSelectFamily`: Node autoSelectFamilyのオーバーライド（true=有効、false=無効）。Node 22+ではデフォルト有効、WSL2ではデフォルト無効。
- `channels.telegram.network.dnsResultOrder`: DNS結果順序のオーバーライド（`ipv4first`または`verbatim`）。Node 22+では`ipv4first`がデフォルト。
- `channels.telegram.proxy`: Bot API呼び出し用プロキシURL（SOCKS/HTTP）。
- `channels.telegram.webhookUrl`: ウェブフックモードの有効化（`channels.telegram.webhookSecret`が必要）。
- `channels.telegram.webhookSecret`: ウェブフックシークレット（webhookUrl設定時に必要）。
- `channels.telegram.webhookPath`: ローカルウェブフックパス（デフォルト`/telegram-webhook`）。
- `channels.telegram.webhookHost`: ローカルウェブフックバインドホスト（デフォルト`127.0.0.1`）。
- `channels.telegram.webhookPort`: ローカルウェブフックバインドポート（デフォルト`8787`）。
- `channels.telegram.actions.reactions`: Telegramツールリアクションのゲート。
- `channels.telegram.actions.sendMessage`: Telegramツールメッセージ送信のゲート。
- `channels.telegram.actions.deleteMessage`: Telegramツールメッセージ削除のゲート。
- `channels.telegram.actions.sticker`: Telegramスタンプアクション（送信と検索）のゲート（デフォルト: false）。
- `channels.telegram.reactionNotifications`: `off | own | all` -- どのリアクションがシステムイベントをトリガーするか制御（未設定時のデフォルト: `own`）。
- `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` -- エージェントのリアクション機能を制御（未設定時のデフォルト: `minimal`）。

- [設定リファレンス - Telegram](/gateway/configuration-reference#telegram)

Telegram固有の重要フィールド:

- 起動/認証: `enabled`、`botToken`、`tokenFile`、`accounts.*`
- アクセス制御: `dmPolicy`、`allowFrom`、`groupPolicy`、`groupAllowFrom`、`groups`、`groups.*.topics.*`
- コマンド/メニュー: `commands.native`、`commands.nativeSkills`、`customCommands`
- スレッディング/返信: `replyToMode`
- ストリーミング: `streaming`（プレビュー）、`blockStreaming`
- フォーマット/配信: `textChunkLimit`、`chunkMode`、`linkPreview`、`responsePrefix`
- メディア/ネットワーク: `mediaMaxMb`、`timeoutSeconds`、`retry`、`network.autoSelectFamily`、`proxy`
- ウェブフック: `webhookUrl`、`webhookSecret`、`webhookPath`、`webhookHost`
- アクション/機能: `capabilities.inlineButtons`、`actions.sendMessage|editMessage|deleteMessage|reactions|sticker`
- リアクション: `reactionNotifications`、`reactionLevel`
- 書き込み/履歴: `configWrites`、`historyLimit`、`dmHistoryLimit`、`dms.*.historyLimit`

## 関連ドキュメント

- [ペアリング](/channels/pairing)
- [チャンネルルーティング](/channels/channel-routing)
- [マルチエージェントルーティング](/concepts/multi-agent)
- [トラブルシューティング](/channels/troubleshooting)
