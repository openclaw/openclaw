---
summary: "Matrix のサポート状況、機能、および設定"
read_when:
  - Matrix チャンネル機能に取り組んでいるとき
title: "Matrix"
---

# Matrix（プラグイン）

Matrixはオープンな分散型メッセージングプロトコルです。 Matrix は、オープンで分散型のメッセージングプロトコルです。OpenClaw は、任意のホームサーバー上の Matrix **ユーザー** として接続するため、ボット用の Matrix アカウントが必要です。ログイン後は、ボットに直接ダイレクトメッセージ（DM）を送ることも、ルーム（Matrix の「グループ」）に招待することもできます。Beeper も有効なクライアントオプションですが、E2EE を有効にする必要があります。 ログインすると、
ボットを直接DMしたり、ルームに招待したりできます(マトリックス「グループ」)。 Beperは
でも有効なクライアントオプションですが、E2EEを有効にする必要があります。

ステータス: プラグイン（@vector-im/matrix-bot-sdk）経由でサポートされています。ダイレクトメッセージ、ルーム、スレッド、メディア、リアクション、投票（送信および poll-start をテキストとして送信）、位置情報、E2EE（暗号化サポートあり）に対応しています。 ダイレクトメッセージ、ルーム、スレッド、メディア、反応、
polls (Send + poll-start as text), location, and E2EE (with crypto support).

## プラグインが必要

Matrix はプラグインとして提供されており、コアインストールには同梱されていません。

CLI（npm レジストリ）経由でインストールします:

```bash
openclaw plugins install @openclaw/matrix
```

ローカルチェックアウト（git リポジトリから実行する場合）:

```bash
openclaw plugins install ./extensions/matrix
```

configure／オンボーディング中に Matrix を選択し、git チェックアウトが検出された場合、OpenClaw はローカルインストールパスを自動的に提示します。

詳細: [Plugins](/tools/plugin)

## セットアップ

1. Matrix プラグインをインストールします:
   - npm から: `openclaw plugins install @openclaw/matrix`
   - ローカルチェックアウトから: `openclaw plugins install ./extensions/matrix`

2. ホームサーバー上で Matrix アカウントを作成します:
   - [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/) でホスティングオプションを確認します。
   - または、自身でホストします。

3. ボットアカウント用のアクセストークンを取得します:

   - ホームサーバー上で、`curl` を使用して Matrix ログイン API を呼び出します:

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

   - `matrix.example.org` をホームサーバーの URL に置き換えます。
   - もしくは `channels.matrix.userId` と `channels.matrix.password` を設定します。OpenClaw は同じログインエンドポイントを呼び出し、アクセストークンを `~/.openclaw/credentials/matrix/credentials.json` に保存し、次回起動時に再利用します。

4. 認証情報を設定します:
   - 環境変数: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN`（または `MATRIX_USER_ID` と `MATRIX_PASSWORD`）
   - または設定: `channels.matrix.*`
   - 両方が設定されている場合は、設定ファイルが優先されます。
   - アクセストークンを使用する場合、ユーザー ID は `/whoami` により自動取得されます。
   - 設定する場合、`channels.matrix.userId` は完全な Matrix ID である必要があります（例: `@bot:example.org`）。

5. Gateway（ゲートウェイ）を再起動します（またはオンボーディングを完了します）。

6. 任意の Matrix クライアント（Element、Beeper など。詳細は [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/) を参照）からボットとの DM を開始するか、ルームに招待します。Beeper では E2EE が必要なため、`channels.matrix.encryption: true` を設定し、デバイスを検証してください。 Beer には E2EE
   が必要なので、`channels.matrix.encryption: true` を設定してデバイスを確認します。

最小構成（アクセストークン使用、ユーザー ID は自動取得）:

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

E2EE 構成（エンドツーエンド暗号化を有効化）:

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

エンドツーエンド暗号化は、Rust の crypto SDK を介して **サポートされています**。

`channels.matrix.encryption: true` で有効にします:

- crypto モジュールがロードされると、暗号化されたルームは自動的に復号されます。
- 暗号化されたルームに送信する際、送信メディアは暗号化されます。
- 初回接続時に、OpenClaw は他のセッションに対してデバイス検証を要求します。
- 別の Matrix クライアント（Element など）でデバイスを検証し、キー共有を有効にします。 キーの共有を可能にしました
- crypto モジュールをロードできない場合、E2EE は無効化され、暗号化されたルームは復号されません。OpenClaw は警告をログに出力します。
- crypto モジュールが見つからないエラー（例: `@matrix-org/matrix-sdk-crypto-nodejs-*`）が表示される場合は、`@matrix-org/matrix-sdk-crypto-nodejs` のビルドスクリプトを許可し、`pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` を実行するか、`node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js` でバイナリを取得してください。

暗号化の状態は、アカウントとアクセストークンごとに `~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/` に保存されます（SQLite データベース）。同期状態は `bot-storage.json` に保存されます。アクセストークン（デバイス）が変更された場合、新しいストアが作成され、暗号化されたルームを利用するには再度検証が必要です。 Sync の状態は `bot-storage.json` に並んでいます。
2. アクセストークン（デバイス）が変更されると、新しいストアが作成され、暗号化されたルームについてはボットを再検証する必要があります。

**デバイス検証:**
E2EE が有効な場合、起動時にボットは他のセッションに対して検証要求を送信します。Element（または別のクライアント）を開き、検証要求を承認して信頼関係を確立してください。検証後、ボットは暗号化されたルーム内のメッセージを復号できます。
要素(または別のクライアント)を開き、信頼を確立するための検証要求を承認します。
確認が完了すると、ボットは暗号化されたルームでメッセージを復号することができます。

## ルーティングモデル

- 返信は常に Matrix に返されます。
- DM はエージェントのメインセッションを共有し、ルームはグループセッションに対応します。

## アクセス制御（DM）

- デフォルト: `channels.matrix.dm.policy = "pairing"`。不明な送信者にはペアリングコードが送信されます。 不明な送信者はペアリングコードを取得します。
- 承認方法:
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- 公開 DM: `channels.matrix.dm.policy="open"` と `channels.matrix.dm.allowFrom=["*"]`。
- `channels.matrix.dm.allowFrom` は完全な Matrix ユーザー ID（例: `@user:server`）を受け付けます。ウィザードは、ディレクトリ検索で単一の完全一致が見つかった場合に表示名をユーザー ID に解決します。 ディレクトリ検索で完全一致が見つかった場合、ウィザードは名前をユーザー ID に表示します。

## ルーム（グループ）

- デフォルト: `channels.matrix.groupPolicy = "allowlist"`（メンション制御）。未設定の場合、`channels.defaults.groupPolicy` でデフォルトを上書きできます。 .tools`: チャンネル上書きがない場合に使用される、チームごとのデフォルトツールポリシー上書き（`allow`/`deny`/`alsoAllow\`）。
- `channels.matrix.groups` でルームの許可リストを設定します（ルーム ID またはエイリアス。ディレクトリ検索で単一の完全一致が見つかった場合、名前は ID に解決されます）:

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

- `requireMention: false` は、そのルームでの自動返信を有効にします。
- `groups."*"` で、ルーム間のメンション制御のデフォルトを設定できます。
- `groupAllowFrom` は、ルーム内でボットをトリガーできる送信者を制限します（完全な Matrix ユーザー ID）。
- ルームごとの `users` 許可リストにより、特定のルーム内でさらに送信者を制限できます（完全な Matrix ユーザー ID を使用）。
- 設定ウィザードでは、ルーム許可リスト（ルーム ID、エイリアス、または名前）の入力を求められ、正確で一意な一致がある場合にのみ名前を解決します。
- 起動時に、OpenClaw は許可リスト内のルーム／ユーザー名を ID に解決し、その対応関係をログに出力します。解決できないエントリは、許可リストの照合では無視されます。
- 招待はデフォルトで自動参加されます。`channels.matrix.autoJoin` および `channels.matrix.autoJoinAllowlist` で制御できます。
- **ルームを一切許可しない** 場合は、`channels.matrix.groupPolicy: "disabled"` を設定します（または空の許可リストを保持します）。
- レガシーキー: `channels.matrix.rooms`（`groups` と同じ構造）。

## スレッド

- 返信スレッドはサポートされています。
- `channels.matrix.threadReplies` は、返信をスレッド内に保持するかどうかを制御します:
  - `off`, `inbound`（デフォルト）, `always`
- `channels.matrix.replyToMode` は、スレッドで返信しない場合の reply-to メタデータを制御します:
  - `off`（デフォルト）, `first`, `all`

## 機能

| 機能         | ステータス                                    |
| ---------- | ---------------------------------------- |
| ダイレクトメッセージ | ✅ サポートされています                             |
| ルーム        | ✅ サポートされています                             |
| スレッド       | ✅ サポートされています                             |
| メディア       | ✅ サポートされています                             |
| E2EE       | ✅ サポートされています（crypto モジュールが必要）            |
| Reactions  | ✅ サポートされています（ツール経由で送受信）                  |
| 投票         | ✅ 送信はサポート。受信した投票開始はテキストに変換されます（回答／終了は無視） |
| 位置情報       | ✅ サポートされています（geo URI。高度は無視されます）          |
| ネイティブコマンド  | ✅ サポートされています                             |

## トラブルシューティング

まず次の手順を実行してください:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

必要に応じて、DM のペアリング状態を確認します:

```bash
openclaw pairing list matrix
```

一般的な障害:

- ログインは成功しているがルームのメッセージが無視される: `groupPolicy` またはルーム許可リストによりブロックされています。
- DM が無視される: `channels.matrix.dm.policy="pairing"` の場合、送信者が承認待ちです。
- 暗号化されたルームが失敗する: crypto サポートまたは暗号化設定の不一致。

トリアージフローについては、[/channels/troubleshooting](/channels/troubleshooting) を参照してください。

## 設定リファレンス（Matrix）

完全な設定: [Configuration](/gateway/configuration)

プロバイダーオプション:

- `channels.matrix.enabled`: チャンネル起動の有効／無効。
- `channels.matrix.homeserver`: ホームサーバー URL。
- `channels.matrix.userId`: Matrix ユーザー ID（アクセストークン使用時は省略可能）。
- `channels.matrix.accessToken`: アクセストークン。
- `channels.matrix.password`: ログイン用パスワード（トークンが保存されます）。
- `channels.matrix.deviceName`: デバイス表示名。
- `channels.matrix.encryption`: E2EE を有効化（デフォルト: false）。
- `channels.matrix.initialSyncLimit`: 初期同期の上限。
- `channels.matrix.threadReplies`: `off | inbound | always`（デフォルト: inbound）。
- `channels.matrix.textChunkLimit`: 送信テキストのチャンクサイズ（文字数）。
- `channels.matrix.chunkMode`: `length`（デフォルト）または `newline`。長さで分割する前に空行（段落境界）で分割します。
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled`（デフォルト: pairing）。
- `channels.matrix.dm.allowFrom`: DM 許可リスト（完全な Matrix ユーザー ID）。`open` には `"*"` が必要です。ウィザードは可能な場合に名前を ID に解決します。 `open`には`"*"`が必要です。 可能な場合、ウィザードは ID に名前を解決します。
- `channels.matrix.groupPolicy`: `allowlist | open | disabled`（デフォルト: allowlist）。
- `channels.matrix.groupAllowFrom`: グループメッセージ用の許可された送信者（完全な Matrix ユーザー ID）。
- `channels.matrix.allowlistOnly`: DM とルームに対して許可リストルールを強制します。
- `channels.matrix.groups`: グループ許可リストおよびルームごとの設定マップ。
- `channels.matrix.rooms`: レガシーなグループ許可リスト／設定。
- `channels.matrix.replyToMode`: スレッド／タグ用の reply-to モード。
- `channels.matrix.mediaMaxMb`: 受信／送信メディアの上限（MB）。
- `channels.matrix.autoJoin`: 招待処理（`always | allowlist | off`、デフォルト: always）。
- `channels.matrix.autoJoinAllowlist`: 自動参加を許可するルーム ID／エイリアス。
- `channels.matrix.actions`: アクションごとのツール制御（reactions/messages/pins/memberInfo/channelInfo）。
