---
summary: "signal-cli（JSON-RPC + SSE）によるSignalサポート、セットアップ手順、番号モデル"
read_when:
  - Signalサポートをセットアップするとき
  - Signalの送受信をデバッグするとき
title: "Signal"
---

# Signal（signal-cli）

ステータス: 外部CLI統合。GatewayはHTTP JSON-RPC + SSE経由で`signal-cli`と通信します。

## 前提条件

- サーバーにOpenClawがインストール済み（以下のLinuxフローはUbuntu 24でテスト済み）。
- Gatewayが実行されるホストで`signal-cli`が利用可能。
- SMS登録パスの場合、検証SMSを1通受信できる電話番号。
- 登録中のSignal captcha（`signalcaptchas.org`）のためのブラウザアクセス。

## クイックセットアップ（初心者向け）

1. ボット用に**別のSignal番号**を使用します（推奨）。
2. `signal-cli`をインストールします（JVMビルドを使用する場合はJavaが必要）。
3. セットアップ方法を選択します:
   - **パスA（QRリンク）:** `signal-cli link -n "OpenClaw"`を実行し、Signalでスキャンします。
   - **パスB（SMS登録）:** captcha + SMS認証で専用番号を登録します。
4. OpenClawを設定し、Gatewayを再起動します。
5. 最初のDMを送信し、ペアリングを承認します（`openclaw pairing approve signal <CODE>`）。

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

| フィールド  | 説明                                              |
| ----------- | ------------------------------------------------- |
| `account`   | E.164形式のボット電話番号（`+15551234567`）       |
| `cliPath`   | `signal-cli`のパス（`PATH`上にあれば`signal-cli`）|
| `dmPolicy`  | DMアクセスポリシー（`pairing`推奨）               |
| `allowFrom` | DMを許可する電話番号または`uuid:<id>`値            |

## 概要

- `signal-cli`経由のSignalチャンネル（組み込みlibsignalではありません）。
- 決定論的ルーティング: 返信は常にSignalに戻ります。
- DMはエージェントのメインセッションを共有します。グループは分離されます（`agent:<agentId>:signal:group:<groupId>`）。

## 設定の書き込み

デフォルトでは、Signalは`/config set|unset`でトリガーされる設定更新の書き込みが許可されています（`commands.config: true`が必要）。

無効化する場合:

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## 番号モデル（重要）

- Gatewayは**Signalデバイス**（`signal-cli`アカウント）に接続します。
- ボットを**個人のSignalアカウント**で実行する場合、ループ保護のため自分自身のメッセージは無視されます。
- 「ボットにテキストを送ると返信が来る」というケースでは、**別のボット番号**を使用してください。

## セットアップパスA: 既存のSignalアカウントをリンク（QR）

1. `signal-cli`をインストールします（JVMまたはネイティブビルド）。
2. ボットアカウントをリンクします:
   - `signal-cli link -n "OpenClaw"`を実行し、SignalでQRをスキャンします。
3. Signalを設定し、Gatewayを起動します。

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

マルチアカウントサポート: `channels.signal.accounts`でアカウントごとの設定とオプションの`name`を使用します。共有パターンについては[`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts)を参照してください。

## セットアップパスB: 専用ボット番号の登録（SMS、Linux）

既存のSignalアプリアカウントをリンクする代わりに、専用のボット番号が必要な場合に使用します。

1. SMSを受信できる番号を取得します（固定電話の場合は音声認証）。
   - アカウント/セッションの競合を避けるため、専用のボット番号を使用してください。
2. Gatewayホストに`signal-cli`をインストールします:

```bash
VERSION=$(curl -Ls -o /dev/null -w %{url_effective} https://github.com/AsamK/signal-cli/releases/latest | sed -e 's/^.*\/v//')
curl -L -O "https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}-Linux-native.tar.gz"
sudo tar xf "signal-cli-${VERSION}-Linux-native.tar.gz" -C /opt
sudo ln -sf /opt/signal-cli /usr/local/bin/
signal-cli --version
```

JVMビルド（`signal-cli-${VERSION}.tar.gz`）を使用する場合は、先にJRE 25以上をインストールしてください。
Signal サーバーAPIの変更により古いリリースが動作しなくなる可能性があるため、`signal-cli`を最新の状態に保ってください。

3. 番号を登録して認証します:

```bash
signal-cli -a +<BOT_PHONE_NUMBER> register
```

captchaが必要な場合:

1. `https://signalcaptchas.org/registration/generate.html`を開きます。
2. captchaを完了し、「Open Signal」から`signalcaptcha://...`リンクターゲットをコピーします。
3. 可能であればブラウザセッションと同じ外部IPから実行します。
4. すぐに登録を再実行します（captchaトークンはすぐに期限切れになります）:

```bash
signal-cli -a +<BOT_PHONE_NUMBER> register --captcha '<SIGNALCAPTCHA_URL>'
signal-cli -a +<BOT_PHONE_NUMBER> verify <VERIFICATION_CODE>
```

4. OpenClawを設定し、Gatewayを再起動してチャンネルを確認します:

```bash
# ユーザーsystemdサービスとしてGatewayを実行している場合:
systemctl --user restart openclaw-gateway

# 確認:
openclaw doctor
openclaw channels status --probe
```

5. DM送信者をペアリングします:
   - ボット番号に任意のメッセージを送信します。
   - サーバーでコードを承認します: `openclaw pairing approve signal <PAIRING_CODE>`。
   - 「不明な連絡先」を避けるため、ボット番号を電話の連絡先として保存してください。

重要: `signal-cli`で電話番号アカウントを登録すると、その番号のメインSignalアプリセッションが認証解除される場合があります。既存の電話アプリのセットアップを維持する必要がある場合は、専用のボット番号を使用するか、QRリンクモードを使用してください。

アップストリームリファレンス:

- `signal-cli` README: `https://github.com/AsamK/signal-cli`
- Captchaフロー: `https://github.com/AsamK/signal-cli/wiki/Registration-with-captcha`
- リンクフロー: `https://github.com/AsamK/signal-cli/wiki/Linking-other-devices-(Provisioning)`

## 外部デーモンモード（httpUrl）

`signal-cli`を自分で管理したい場合（JVMのコールドスタートが遅い、コンテナ初期化、共有CPU）、デーモンを別途実行してOpenClawをポイントします:

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

これにより自動起動とOpenClaw内の起動待ちがスキップされます。自動起動時のスタートが遅い場合は、`channels.signal.startupTimeoutMs`を設定してください。

## アクセス制御（DM + グループ）

DM:

- デフォルト: `channels.signal.dmPolicy = "pairing"`。
- 未知の送信者にはペアリングコードが送信されます。承認されるまでメッセージは無視されます（コードは1時間後に期限切れ）。
- 承認方法:
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CODE>`
- ペアリングはSignal DMのデフォルトのトークン交換です。詳細: [ペアリング](/channels/pairing)
- UUID専用の送信者（`sourceUuid`から）は`uuid:<id>`として`channels.signal.allowFrom`に保存されます。

グループ:

- `channels.signal.groupPolicy = open | allowlist | disabled`。
- `channels.signal.groupAllowFrom`は`allowlist`設定時にグループ内でトリガーできるユーザーを制御します。
- ランタイムの注意: `channels.signal`が完全に欠けている場合、ランタイムはグループチェックに対して`groupPolicy="allowlist"`にフォールバックします（`channels.defaults.groupPolicy`が設定されていても）。

## 動作の仕組み

- `signal-cli`はデーモンとして実行され、GatewayはSSE経由でイベントを読み取ります。
- 受信メッセージは共有チャンネルエンベロープに正規化されます。
- 返信は常に同じ番号またはグループにルーティングされます。

## メディア + 制限

- 送信テキストは`channels.signal.textChunkLimit`（デフォルト4000）でチャンク分割されます。
- オプションの改行チャンキング: `channels.signal.chunkMode="newline"`を設定すると、長さチャンキングの前に空行（段落境界）で分割します。
- 添付ファイルがサポートされています（`signal-cli`からbase64で取得）。
- デフォルトのメディア上限: `channels.signal.mediaMaxMb`（デフォルト8）。
- `channels.signal.ignoreAttachments`でメディアのダウンロードをスキップできます。
- グループ履歴コンテキストは`channels.signal.historyLimit`（または`channels.signal.accounts.*.historyLimit`）を使用し、`messages.groupChat.historyLimit`にフォールバックします。`0`で無効化（デフォルト50）。

## タイピング + 既読レシート

- **タイピングインジケーター**: OpenClawは`signal-cli sendTyping`経由でタイピングシグナルを送信し、返信の実行中にリフレッシュします。
- **既読レシート**: `channels.signal.sendReadReceipts`がtrueの場合、OpenClawは許可されたDMの既読レシートを転送します。
- signal-cliはグループの既読レシートを公開しません。

## リアクション（メッセージツール）

- `message action=react`を`channel=signal`で使用します。
- ターゲット: 送信者のE.164またはUUID（ペアリング出力からの`uuid:<id>`を使用。ベアUUIDも可）。
- `messageId`はリアクションするメッセージのSignalタイムスタンプです。
- グループリアクションには`targetAuthor`または`targetAuthorUuid`が必要です。

例:

```
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

設定:

- `channels.signal.actions.reactions`: リアクションアクションの有効/無効（デフォルトtrue）。
- `channels.signal.reactionLevel`: `off | ack | minimal | extensive`。
  - `off`/`ack`はエージェントのリアクションを無効化します（メッセージツールの`react`はエラーになります）。
  - `minimal`/`extensive`はエージェントのリアクションを有効化し、ガイダンスレベルを設定します。
- アカウントごとのオーバーライド: `channels.signal.accounts.<id>.actions.reactions`、`channels.signal.accounts.<id>.reactionLevel`。

## 配信ターゲット（CLI/cron）

- DM: `signal:+15551234567`（またはプレーンなE.164）。
- UUID DM: `uuid:<id>`（またはベアUUID）。
- グループ: `signal:group:<groupId>`。
- ユーザー名: `username:<name>`（Signalアカウントがサポートしている場合）。

## トラブルシューティング

まず以下の手順を実行します:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

次に、必要に応じてDMペアリング状態を確認します:

```bash
openclaw pairing list signal
```

よくある問題:

- デーモンに接続できるが返信がない: アカウント/デーモン設定（`httpUrl`、`account`）と受信モードを確認してください。
- DMが無視される: 送信者がペアリング承認待ちです。
- グループメッセージが無視される: グループの送信者/メンションゲーティングが配信をブロックしています。
- 編集後の設定バリデーションエラー: `openclaw doctor --fix`を実行してください。
- 診断にSignalが表示されない: `channels.signal.enabled: true`を確認してください。

追加チェック:

```bash
openclaw pairing list signal
pgrep -af signal-cli
grep -i "signal" "/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log" | tail -20
```

トリアージフロー: [/channels/troubleshooting](/channels/troubleshooting)。

## セキュリティノート

- `signal-cli`はアカウントキーをローカルに保存します（通常`~/.local/share/signal-cli/data/`）。
- サーバー移行やリビルド前にSignalアカウントの状態をバックアップしてください。
- 明示的により広いDMアクセスが必要でない限り、`channels.signal.dmPolicy: "pairing"`を維持してください。
- SMS認証は登録またはリカバリフローにのみ必要ですが、番号/アカウントの制御を失うと再登録が複雑になる可能性があります。

## 設定リファレンス（Signal）

完全な設定: [設定](/gateway/configuration)

プロバイダーオプション:

- `channels.signal.enabled`: チャンネル起動の有効/無効。
- `channels.signal.account`: ボットアカウントのE.164。
- `channels.signal.cliPath`: `signal-cli`のパス。
- `channels.signal.httpUrl`: フルデーモンURL（host/portをオーバーライド）。
- `channels.signal.httpHost`、`channels.signal.httpPort`: デーモンバインド（デフォルト127.0.0.1:8080）。
- `channels.signal.autoStart`: デーモンの自動起動（`httpUrl`未設定の場合デフォルトtrue）。
- `channels.signal.startupTimeoutMs`: 起動待ちタイムアウト（ミリ秒、上限120000）。
- `channels.signal.receiveMode`: `on-start | manual`。
- `channels.signal.ignoreAttachments`: 添付ファイルのダウンロードをスキップ。
- `channels.signal.ignoreStories`: デーモンからのストーリーを無視。
- `channels.signal.sendReadReceipts`: 既読レシートの転送。
- `channels.signal.dmPolicy`: `pairing | allowlist | open | disabled`（デフォルト: pairing）。
- `channels.signal.allowFrom`: DM許可リスト（E.164または`uuid:<id>`）。`open`には`"*"`が必要。Signalにはユーザー名がないため、電話/UUID IDを使用してください。
- `channels.signal.groupPolicy`: `open | allowlist | disabled`（デフォルト: allowlist）。
- `channels.signal.groupAllowFrom`: グループ送信者許可リスト。
- `channels.signal.historyLimit`: コンテキストとして含めるグループメッセージの最大数（0で無効化）。
- `channels.signal.dmHistoryLimit`: DM履歴制限（ユーザーターン数）。ユーザーごとのオーバーライド: `channels.signal.dms["<phone_or_uuid>"].historyLimit`。
- `channels.signal.textChunkLimit`: 送信チャンクサイズ（文字数）。
- `channels.signal.chunkMode`: `length`（デフォルト）または`newline`で空行（段落境界）で分割後に長さチャンキング。
- `channels.signal.mediaMaxMb`: 受信/送信メディア上限（MB）。

関連グローバルオプション:

- `agents.list[].groupChat.mentionPatterns`（Signalはネイティブメンションをサポートしていません）。
- `messages.groupChat.mentionPatterns`（グローバルフォールバック）。
- `messages.responsePrefix`。
