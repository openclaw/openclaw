---
read_when:
    - Signalサポートのセットアップ
    - Signalの送受信のデバッグ
summary: signal-cli（JSON-RPC + SSE）によるSignalサポート、セットアップ手順、および番号モデル
title: Signal
x-i18n:
    generated_at: "2026-04-02T08:54:42Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 4aa00a255bbbe4dc9f4e41219500392f35fad5fba6482034a42e99e7f2d51d90
    source_path: channels/signal.md
    workflow: 15
---

# Signal (signal-cli)

ステータス: 外部CLIとの統合。Gateway ゲートウェイはHTTP JSON-RPC + SSEを介して`signal-cli`と通信します。

## 前提条件

- サーバーにOpenClawがインストールされていること（以下のLinuxフローはUbuntu 24でテスト済み）。
- Gateway ゲートウェイが動作するホストで`signal-cli`が利用可能であること。
- 確認用SMSを1通受信できる電話番号（SMS登録パスの場合）。
- 登録時のSignalキャプチャ（`signalcaptchas.org`）用のブラウザアクセス。

## クイックセットアップ（初心者向け）

1. ボット用に**別のSignal番号**を使用します（推奨）。
2. `signal-cli`をインストールします（JVMビルドを使用する場合はJavaが必要）。
3. セットアップパスを選択します:
   - **パスA（QRリンク）:** `signal-cli link -n "OpenClaw"`を実行し、Signalでスキャンします。
   - **パスB（SMS登録）:** キャプチャ + SMS認証で専用番号を登録します。
4. OpenClawを設定し、Gateway ゲートウェイを再起動します。
5. 最初のダイレクトメッセージを送信し、ペアリングを承認します（`openclaw pairing approve signal <CODE>`）。

最小設定:

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

フィールドリファレンス:

| フィールド  | 説明                                                |
| ----------- | --------------------------------------------------- |
| `account`   | E.164形式のボット電話番号（`+15551234567`）         |
| `cliPath`   | `signal-cli`のパス（`PATH`上にあれば`signal-cli`）  |
| `dmPolicy`  | ダイレクトメッセージのアクセスポリシー（`pairing`推奨） |
| `allowFrom` | ダイレクトメッセージを許可する電話番号または`uuid:<id>`の値 |

## 概要

- `signal-cli`経由のSignalチャネル（libsignalの組み込みではありません）。
- 確定的ルーティング: 返信は常にSignalに戻ります。
- ダイレクトメッセージはエージェントのメインセッションを共有します。グループは分離されます（`agent:<agentId>:signal:group:<groupId>`）。

## 設定の書き込み

デフォルトでは、Signalは`/config set|unset`によってトリガーされる設定更新の書き込みが許可されています（`commands.config: true`が必要）。

無効にするには:

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## 番号モデル（重要）

- Gateway ゲートウェイは**Signalデバイス**（`signal-cli`アカウント）に接続します。
- **個人のSignalアカウント**でボットを実行する場合、自分自身のメッセージは無視されます（ループ防止）。
- 「ボットにテキストを送信して返信を受け取る」には、**専用のボット番号**を使用してください。

## セットアップパスA: 既存のSignalアカウントをリンク（QR）

1. `signal-cli`をインストールします（JVMまたはネイティブビルド）。
2. ボットアカウントをリンクします:
   - `signal-cli link -n "OpenClaw"`を実行し、SignalでQRをスキャンします。
3. Signalを設定し、Gateway ゲートウェイを起動します。

例:

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

マルチアカウントサポート: `channels.signal.accounts`を使用し、アカウントごとの設定とオプションの`name`を指定します。共通パターンについては[`gateway/configuration`](/gateway/configuration-reference#multi-account-all-channels)を参照してください。

## セットアップパスB: 専用ボット番号の登録（SMS、Linux）

既存のSignalアプリアカウントをリンクするのではなく、専用のボット番号が必要な場合にこれを使用します。

1. SMSを受信できる番号を取得します（固定電話の場合は音声認証も可）。
   - アカウント/セッションの競合を避けるため、専用のボット番号を使用してください。
2. Gateway ゲートウェイホストに`signal-cli`をインストールします:

```bash
VERSION=$(curl -Ls -o /dev/null -w %{url_effective} https://github.com/AsamK/signal-cli/releases/latest | sed -e 's/^.*\/v//')
curl -L -O "https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}-Linux-native.tar.gz"
sudo tar xf "signal-cli-${VERSION}-Linux-native.tar.gz" -C /opt
sudo ln -sf /opt/signal-cli /usr/local/bin/
signal-cli --version
```

JVMビルド（`signal-cli-${VERSION}.tar.gz`）を使用する場合は、先にJRE 25以上をインストールしてください。
`signal-cli`は最新に保ってください。Signal サーバーAPIの変更により古いリリースが動作しなくなる場合があると上流で注記されています。

3. 番号を登録して確認します:

```bash
signal-cli -a +<BOT_PHONE_NUMBER> register
```

キャプチャが必要な場合:

1. `https://signalcaptchas.org/registration/generate.html`を開きます。
2. キャプチャを完了し、「Open Signal」から`signalcaptcha://...`のリンク先をコピーします。
3. 可能であれば、ブラウザセッションと同じ外部IPから実行してください。
4. すぐに登録を再度実行します（キャプチャトークンはすぐに期限切れになります）:

```bash
signal-cli -a +<BOT_PHONE_NUMBER> register --captcha '<SIGNALCAPTCHA_URL>'
signal-cli -a +<BOT_PHONE_NUMBER> verify <VERIFICATION_CODE>
```

4. OpenClawを設定し、Gateway ゲートウェイを再起動して、チャネルを確認します:

```bash
# Gateway ゲートウェイをユーザーsystemdサービスとして実行している場合:
systemctl --user restart openclaw-gateway

# 確認:
openclaw doctor
openclaw channels status --probe
```

5. ダイレクトメッセージの送信者をペアリングします:
   - ボット番号に任意のメッセージを送信します。
   - サーバーでコードを承認します: `openclaw pairing approve signal <PAIRING_CODE>`。
   - 「不明な連絡先」を避けるため、ボット番号を電話の連絡先に保存してください。

重要: `signal-cli`で電話番号アカウントを登録すると、その番号のメインSignalアプリセッションが認証解除される場合があります。専用のボット番号を使用するか、既存の電話アプリの設定を維持する必要がある場合はQRリンクモードを使用してください。

上流リファレンス:

- `signal-cli` README: `https://github.com/AsamK/signal-cli`
- キャプチャフロー: `https://github.com/AsamK/signal-cli/wiki/Registration-with-captcha`
- リンクフロー: `https://github.com/AsamK/signal-cli/wiki/Linking-other-devices-(Provisioning)`

## 外部デーモンモード (httpUrl)

`signal-cli`を自分で管理したい場合（JVMのコールドスタートが遅い、コンテナの初期化、共有CPUなど）、デーモンを別途実行し、OpenClawからそれを指定します:

```json5
{
  channels: {
    signal: {
      httpUrl: "http://127.0.0.1:8080",
      autoStart: false,
    },
  },
}
```

これにより、OpenClaw内部での自動起動と起動待機がスキップされます。自動起動時の起動が遅い場合は、`channels.signal.startupTimeoutMs`を設定してください。

## アクセス制御（ダイレクトメッセージ + グループ）

ダイレクトメッセージ:

- デフォルト: `channels.signal.dmPolicy = "pairing"`。
- 不明な送信者にはペアリングコードが送信され、承認されるまでメッセージは無視されます（コードは1時間後に期限切れ）。
- 承認方法:
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CODE>`
- ペアリングはSignalダイレクトメッセージのデフォルトのトークン交換です。詳細: [ペアリング](/channels/pairing)
- UUID専用の送信者（`sourceUuid`から）は`channels.signal.allowFrom`に`uuid:<id>`として保存されます。

グループ:

- `channels.signal.groupPolicy = open | allowlist | disabled`。
- `channels.signal.groupAllowFrom`は`allowlist`設定時にグループ内でトリガーできる人を制御します。
- `channels.signal.groups["<group-id>" | "*"]`で`requireMention`、`tools`、`toolsBySender`によるグループ動作のオーバーライドが可能です。
- マルチアカウントセットアップでのアカウントごとのオーバーライドには`channels.signal.accounts.<id>.groups`を使用します。
- ランタイムの注意: `channels.signal`が完全に欠落している場合、グループチェックでは`groupPolicy="allowlist"`にフォールバックします（`channels.defaults.groupPolicy`が設定されている場合でも）。

## 動作の仕組み

- `signal-cli`はデーモンとして実行され、Gateway ゲートウェイはSSE経由でイベントを読み取ります。
- 受信メッセージは共有チャネルエンベロープに正規化されます。
- 返信は常に同じ番号またはグループにルーティングされます。

## メディア + 制限

- 送信テキストは`channels.signal.textChunkLimit`（デフォルト4000）で分割されます。
- オプションの改行分割: `channels.signal.chunkMode="newline"`を設定すると、長さによる分割の前に空行（段落境界）で分割します。
- 添付ファイルがサポートされています（`signal-cli`からbase64で取得）。
- デフォルトのメディア上限: `channels.signal.mediaMaxMb`（デフォルト8）。
- メディアのダウンロードをスキップするには`channels.signal.ignoreAttachments`を使用します。
- グループ履歴コンテキストは`channels.signal.historyLimit`（または`channels.signal.accounts.*.historyLimit`）を使用し、`messages.groupChat.historyLimit`にフォールバックします。`0`で無効化します（デフォルト50）。

## タイピング + 既読確認

- **タイピングインジケーター**: OpenClawは`signal-cli sendTyping`を介してタイピングシグナルを送信し、返信の実行中にリフレッシュします。
- **既読確認**: `channels.signal.sendReadReceipts`がtrueの場合、OpenClawは許可されたダイレクトメッセージの既読確認を転送します。
- signal-cliはグループの既読確認を公開しません。

## リアクション（messageツール）

- `channel=signal`で`message action=react`を使用します。
- ターゲット: 送信者のE.164またはUUID（ペアリング出力の`uuid:<id>`を使用。ベアUUIDも動作します）。
- `messageId`はリアクションする対象メッセージのSignalタイムスタンプです。
- グループリアクションには`targetAuthor`または`targetAuthorUuid`が必要です。

例:

```
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

設定:

- `channels.signal.actions.reactions`: リアクションアクションの有効化/無効化（デフォルトtrue）。
- `channels.signal.reactionLevel`: `off | ack | minimal | extensive`。
  - `off`/`ack`はエージェントのリアクションを無効にします（messageツールの`react`はエラーになります）。
  - `minimal`/`extensive`はエージェントのリアクションを有効にし、ガイダンスレベルを設定します。
- アカウントごとのオーバーライド: `channels.signal.accounts.<id>.actions.reactions`、`channels.signal.accounts.<id>.reactionLevel`。

## 配信ターゲット（CLI/cron）

- ダイレクトメッセージ: `signal:+15551234567`（またはプレーンE.164）。
- UUIDダイレクトメッセージ: `uuid:<id>`（またはベアUUID）。
- グループ: `signal:group:<groupId>`。
- ユーザー名: `username:<name>`（Signalアカウントがサポートしている場合）。

## トラブルシューティング

まず以下の手順を実行してください:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

次に、必要に応じてダイレクトメッセージのペアリング状態を確認します:

```bash
openclaw pairing list signal
```

よくある障害:

- デーモンに到達可能だが返信がない: アカウント/デーモン設定（`httpUrl`、`account`）と受信モードを確認してください。
- ダイレクトメッセージが無視される: 送信者がペアリング承認待ちです。
- グループメッセージが無視される: グループの送信者/メンションゲーティングが配信をブロックしています。
- 編集後の設定バリデーションエラー: `openclaw doctor --fix`を実行してください。
- 診断にSignalが表示されない: `channels.signal.enabled: true`を確認してください。

追加チェック:

```bash
openclaw pairing list signal
pgrep -af signal-cli
grep -i "signal" "/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log" | tail -20
```

トリアージフローについては: [/channels/troubleshooting](/channels/troubleshooting)を参照してください。

## セキュリティに関する注意

- `signal-cli`はアカウントキーをローカルに保存します（通常`~/.local/share/signal-cli/data/`）。
- サーバーの移行やリビルドの前にSignalアカウントの状態をバックアップしてください。
- より広範なダイレクトメッセージアクセスを明示的に許可したい場合を除き、`channels.signal.dmPolicy: "pairing"`を維持してください。
- SMS認証は登録またはリカバリーフローでのみ必要ですが、番号/アカウントの制御を失うと再登録が複雑になる可能性があります。

## 設定リファレンス（Signal）

完全な設定: [設定](/gateway/configuration)

プロバイダーオプション:

- `channels.signal.enabled`: チャネル起動の有効化/無効化。
- `channels.signal.account`: ボットアカウントのE.164。
- `channels.signal.cliPath`: `signal-cli`のパス。
- `channels.signal.httpUrl`: 完全なデーモンURL（host/portをオーバーライド）。
- `channels.signal.httpHost`、`channels.signal.httpPort`: デーモンのバインド先（デフォルト127.0.0.1:8080）。
- `channels.signal.autoStart`: デーモンの自動起動（`httpUrl`未設定の場合デフォルトtrue）。
- `channels.signal.startupTimeoutMs`: 起動待機タイムアウト（ミリ秒、上限120000）。
- `channels.signal.receiveMode`: `on-start | manual`。
- `channels.signal.ignoreAttachments`: 添付ファイルのダウンロードをスキップ。
- `channels.signal.ignoreStories`: デーモンからのストーリーを無視。
- `channels.signal.sendReadReceipts`: 既読確認の転送。
- `channels.signal.dmPolicy`: `pairing | allowlist | open | disabled`（デフォルト: pairing）。
- `channels.signal.allowFrom`: ダイレクトメッセージの許可リスト（E.164または`uuid:<id>`）。`open`には`"*"`が必要です。Signalにはユーザー名がないため、電話番号/UUID IDを使用してください。
- `channels.signal.groupPolicy`: `open | allowlist | disabled`（デフォルト: allowlist）。
- `channels.signal.groupAllowFrom`: グループ送信者の許可リスト。
- `channels.signal.groups`: SignalグループID（または`"*"`）をキーとしたグループごとのオーバーライド。サポートされるフィールド: `requireMention`、`tools`、`toolsBySender`。
- `channels.signal.accounts.<id>.groups`: マルチアカウントセットアップ用の`channels.signal.groups`のアカウントごとバージョン。
- `channels.signal.historyLimit`: コンテキストに含めるグループメッセージの最大数（0で無効化）。
- `channels.signal.dmHistoryLimit`: ダイレクトメッセージの履歴制限（ユーザーターン単位）。ユーザーごとのオーバーライド: `channels.signal.dms["<phone_or_uuid>"].historyLimit`。
- `channels.signal.textChunkLimit`: 送信チャンクサイズ（文字数）。
- `channels.signal.chunkMode`: `length`（デフォルト）または`newline`で空行（段落境界）で分割してから長さで分割。
- `channels.signal.mediaMaxMb`: 受信/送信メディアの上限（MB）。

関連するグローバルオプション:

- `agents.list[].groupChat.mentionPatterns`（Signalはネイティブメンションをサポートしていません）。
- `messages.groupChat.mentionPatterns`（グローバルフォールバック）。
- `messages.responsePrefix`。

## 関連

- [チャネル概要](/channels) — サポートされているすべてのチャネル
- [ペアリング](/channels/pairing) — ダイレクトメッセージの認証とペアリングフロー
- [グループ](/channels/groups) — グループチャットの動作とメンションゲーティング
- [チャネルルーティング](/channels/channel-routing) — メッセージのセッションルーティング
- [セキュリティ](/gateway/security) — アクセスモデルとハードニング
