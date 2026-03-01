---
summary: "Matrixのサポート状況、機能、設定"
read_when:
  - Matrixチャンネル機能を作業するとき
title: "Matrix"
---

# Matrix（プラグイン）

Matrixはオープンで分散型のメッセージングプロトコルです。OpenClawは任意のホームサーバー上のMatrix**ユーザー**として接続するため、ボット用のMatrixアカウントが必要です。ログインすると、ボットに直接DMを送信したり、ルーム（Matrixの「グループ」）に招待したりできます。Beeperも有効なクライアントオプションですが、E2EEの有効化が必要です。

ステータス: プラグインでサポート（@vector-im/matrix-bot-sdk）。ダイレクトメッセージ、ルーム、スレッド、メディア、リアクション、投票（送信 + poll-startをテキストとして）、位置情報、E2EE（暗号化サポート付き）。

## プラグインが必要です

Matrixはプラグインとして提供されており、コアインストールにはバンドルされていません。

CLI経由でインストール（npmレジストリ）:

```bash
openclaw plugins install @openclaw/matrix
```

ローカルチェックアウト（gitリポジトリから実行する場合）:

```bash
openclaw plugins install ./extensions/matrix
```

設定/オンボーディング中にMatrixを選択し、gitチェックアウトが検出された場合、OpenClawはローカルインストールパスを自動的に提案します。

詳細: [プラグイン](/tools/plugin)

## セットアップ

1. Matrixプラグインをインストールします:
   - npmから: `openclaw plugins install @openclaw/matrix`
   - ローカルチェックアウトから: `openclaw plugins install ./extensions/matrix`
2. ホームサーバー上にMatrixアカウントを作成します:
   - [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)でホスティングオプションを閲覧
   - または自分でホストします。
3. ボットアカウントのアクセストークンを取得します:
   - ホームサーバーでMatrix login APIを`curl`で使用:

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - `matrix.example.org`をホームサーバーURLに置き換えてください。
   - または`channels.matrix.userId` + `channels.matrix.password`を設定: OpenClawは同じログインエンドポイントを呼び出し、`~/.openclaw/credentials/matrix/credentials.json`にアクセストークンを保存し、次回起動時に再利用します。

4. 認証情報を設定:
   - 環境変数: `MATRIX_HOMESERVER`、`MATRIX_ACCESS_TOKEN`（または`MATRIX_USER_ID` + `MATRIX_PASSWORD`）
   - または設定: `channels.matrix.*`
   - 両方設定されている場合、設定が優先されます。
   - アクセストークンの場合: ユーザーIDは`/whoami`経由で自動取得されます。
   - 設定する場合、`channels.matrix.userId`は完全なMatrix ID（例: `@bot:example.org`）にする必要があります。
5. Gatewayを再起動します（またはオンボーディングを完了します）。
6. Matrixクライアント（Element、Beeperなど。[https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/)を参照）からボットにDMを開始するか、ルームに招待します。BeeperにはE2EEが必要なため、`channels.matrix.encryption: true`を設定してデバイスを検証してください。

最小設定（アクセストークン、ユーザーID自動取得）:

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

E2EE設定（エンドツーエンド暗号化有効）:

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

## 暗号化（E2EE）

エンドツーエンド暗号化はRust暗号化SDKを介して**サポート**されています。

`channels.matrix.encryption: true`で有効化:

- 暗号化モジュールがロードされた場合、暗号化されたルームは自動的に復号化されます。
- 暗号化されたルームに送信する場合、送信メディアは暗号化されます。
- 初回接続時、OpenClawは他のセッションからデバイス検証を要求します。
- 別のMatrixクライアント（Elementなど）でデバイスを検証して鍵共有を有効にします。
- 暗号化モジュールをロードできない場合、E2EEは無効になり暗号化されたルームは復号化されません。OpenClawは警告をログに記録します。
- 暗号化モジュールのエラー（例: `@matrix-org/matrix-sdk-crypto-nodejs-*`）が表示される場合、`@matrix-org/matrix-sdk-crypto-nodejs`のビルドスクリプトを許可し、`pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs`を実行するか、`node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`でバイナリを取得してください。

暗号化の状態はアカウント + アクセストークンごとに`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`（SQLiteデータベース）に保存されます。同期状態は`bot-storage.json`に並んで保存されます。アクセストークン（デバイス）が変更された場合、新しいストアが作成され、暗号化されたルームではボットの再検証が必要です。

**デバイス検証:**
E2EEが有効な場合、ボットは起動時に他のセッションからの検証を要求します。Element（または別のクライアント）を開いて検証リクエストを承認し、信頼を確立してください。検証後、ボットは暗号化されたルームでメッセージを復号化できます。

## マルチアカウント

マルチアカウントサポート: `channels.matrix.accounts`でアカウントごとの認証情報とオプションの`name`を使用します。共有パターンについては[`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts)を参照してください。

各アカウントは任意のホームサーバー上の個別のMatrixユーザーとして実行されます。アカウントごとの設定はトップレベルの`channels.matrix`設定を継承し、任意のオプション（DMポリシー、グループ、暗号化など）をオーバーライドできます。

```json5
{
  channels: {
    matrix: {
      enabled: true,
      dm: { policy: "pairing" },
      accounts: {
        assistant: {
          name: "Main assistant",
          homeserver: "https://matrix.example.org",
          accessToken: "syt_assistant_***",
          encryption: true,
        },
        alerts: {
          name: "Alerts bot",
          homeserver: "https://matrix.example.org",
          accessToken: "syt_alerts_***",
          dm: { policy: "allowlist", allowFrom: ["@admin:example.org"] },
        },
      },
    },
  },
}
```

注意:

- アカウントの起動は、並行モジュールインポートの競合条件を避けるためにシリアライズされます。
- 環境変数（`MATRIX_HOMESERVER`、`MATRIX_ACCESS_TOKEN`など）は**デフォルト**アカウントにのみ適用されます。
- ベースチャンネル設定（DMポリシー、グループポリシー、メンションゲーティングなど）はアカウントごとにオーバーライドされない限り、すべてのアカウントに適用されます。
- `bindings[].match.accountId`を使用して各アカウントを異なるエージェントにルーティングできます。
- 暗号化の状態はアカウント + アクセストークンごとに保存されます（アカウントごとに個別のキーストア）。

## ルーティングモデル

- 返信は常にMatrixに戻ります。
- DMはエージェントのメインセッションを共有します。ルームはグループセッションにマッピングされます。

## アクセス制御（DM）

- デフォルト: `channels.matrix.dm.policy = "pairing"`。未知の送信者にはペアリングコードが送信されます。
- 承認方法:
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- パブリックDM: `channels.matrix.dm.policy="open"`に加えて`channels.matrix.dm.allowFrom=["*"]`。
- `channels.matrix.dm.allowFrom`は完全なMatrix ユーザーID（例: `@user:server`）を受け入れます。ウィザードはディレクトリ検索で単一の完全一致が見つかった場合、表示名をユーザーIDに解決します。
- 表示名やベアローカルパート（例: `"Alice"`や`"alice"`）は使用しないでください。曖昧であり、許可リストマッチングでは無視されます。完全な`@user:server` IDを使用してください。

## ルーム（グループ）

- デフォルト: `channels.matrix.groupPolicy = "allowlist"`（メンションゲーティング）。`channels.defaults.groupPolicy`でデフォルトをオーバーライドできます。
- ランタイムの注意: `channels.matrix`が完全に欠けている場合、ランタイムはルームチェックに対して`groupPolicy="allowlist"`にフォールバックします（`channels.defaults.groupPolicy`が設定されていても）。
- `channels.matrix.groups`でルームを許可リストに登録（ルームIDまたはエイリアス。ディレクトリ検索で単一の完全一致が見つかった場合、名前はIDに解決されます）:

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: ["@owner:example.org"],
    },
  },
}
```

- `requireMention: false`でそのルームでの自動返信を有効にします。
- `groups."*"`でルーム全体のメンションゲーティングのデフォルトを設定できます。
- `groupAllowFrom`はルームでボットをトリガーできる送信者を制限します（完全なMatrix ユーザーID）。
- ルームごとの`users`許可リストで特定ルーム内の送信者をさらに制限できます（完全なMatrix ユーザーIDを使用）。
- 設定ウィザードはルーム許可リスト（ルームID、エイリアス、または名前）の入力を求め、正確で一意の一致の場合のみ名前を解決します。
- 起動時、OpenClawは許可リスト内のルーム/ユーザー名をIDに解決し、マッピングをログに記録します。未解決のエントリは許可リストマッチングでは無視されます。
- 招待はデフォルトで自動参加されます。`channels.matrix.autoJoin`と`channels.matrix.autoJoinAllowlist`で制御します。
- **ルームを許可しない**場合: `channels.matrix.groupPolicy: "disabled"`を設定します（または許可リストを空のままにします）。
- レガシーキー: `channels.matrix.rooms`（`groups`と同じ形式）。

## スレッド

- 返信スレッドがサポートされています。
- `channels.matrix.threadReplies`は返信がスレッド内に留まるかどうかを制御します:
  - `off`、`inbound`（デフォルト）、`always`
- `channels.matrix.replyToMode`はスレッドで返信しない場合のreply-toメタデータを制御します:
  - `off`（デフォルト）、`first`、`all`

## 機能

| 機能           | ステータス                                                                          |
| --------------- | --------------------------------------------------------------------------------- |
| ダイレクトメッセージ | サポート済み                                                                      |
| ルーム         | サポート済み                                                                      |
| スレッド       | サポート済み                                                                      |
| メディア       | サポート済み                                                                      |
| E2EE           | サポート済み（暗号化モジュール必須）                                                |
| リアクション   | サポート済み（ツール経由で送信/読み取り）                                            |
| 投票           | 送信サポート済み。受信のpoll startはテキストに変換（responses/endsは無視）            |
| 位置情報       | サポート済み（geo URI。高度は無視）                                                 |
| ネイティブコマンド | サポート済み                                                                    |

## トラブルシューティング

まず以下のコマンドを実行してください:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

必要に応じてDMペアリング状態を確認:

```bash
openclaw pairing list matrix
```

一般的な障害:

- ログイン済みだがルームメッセージが無視される: `groupPolicy`またはルーム許可リストでブロックされています。
- DMが無視される: `channels.matrix.dm.policy="pairing"`の場合、送信者は承認待ちです。
- 暗号化されたルームが失敗する: 暗号化サポートまたは暗号化設定の不一致。

トリアージフロー: [/channels/troubleshooting](/channels/troubleshooting)

## 設定リファレンス（Matrix）

完全な設定: [設定](/gateway/configuration)

プロバイダーオプション:

- `channels.matrix.enabled`: チャンネル起動の有効/無効。
- `channels.matrix.homeserver`: ホームサーバーURL。
- `channels.matrix.userId`: Matrix ユーザーID（アクセストークン使用時はオプション）。
- `channels.matrix.accessToken`: アクセストークン。
- `channels.matrix.password`: ログイン用パスワード（トークンが保存されます）。
- `channels.matrix.deviceName`: デバイス表示名。
- `channels.matrix.encryption`: E2EEの有効化（デフォルト: false）。
- `channels.matrix.initialSyncLimit`: 初期同期制限。
- `channels.matrix.threadReplies`: `off | inbound | always`（デフォルト: inbound）。
- `channels.matrix.textChunkLimit`: 送信テキストチャンクサイズ（文字数）。
- `channels.matrix.chunkMode`: `length`（デフォルト）または`newline`で空行（段落境界）で分割してから長さ分割。
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled`（デフォルト: pairing）。
- `channels.matrix.dm.allowFrom`: DM許可リスト（完全なMatrix ユーザーID）。`open`には`"*"`が必要。ウィザードは可能な場合名前をIDに解決します。
- `channels.matrix.groupPolicy`: `allowlist | open | disabled`（デフォルト: allowlist）。
- `channels.matrix.groupAllowFrom`: グループメッセージの許可された送信者（完全なMatrix ユーザーID）。
- `channels.matrix.allowlistOnly`: DM + ルームに許可リストルールを強制。
- `channels.matrix.groups`: グループ許可リスト + ルームごとの設定マップ。
- `channels.matrix.rooms`: レガシーグループ許可リスト/設定。
- `channels.matrix.replyToMode`: スレッド/タグのreply-toモード。
- `channels.matrix.mediaMaxMb`: 受信/送信メディア上限（MB）。
- `channels.matrix.autoJoin`: 招待処理（`always | allowlist | off`、デフォルト: always）。
- `channels.matrix.autoJoinAllowlist`: 自動参加の許可されたルームID/エイリアス。
- `channels.matrix.accounts`: アカウントIDをキーとしたマルチアカウント設定（各アカウントはトップレベルの設定を継承）。
- `channels.matrix.actions`: アクションごとのツールゲーティング（reactions/messages/pins/memberInfo/channelInfo）。
