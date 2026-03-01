---
summary: "MattermostボットのセットアップとOpenClaw設定"
read_when:
  - Mattermostをセットアップするとき
  - Mattermostルーティングをデバッグするとき
title: "Mattermost"
---

# Mattermost（プラグイン）

ステータス: プラグインでサポート（ボットトークン + WebSocketイベント）。チャンネル、グループ、DMがサポートされています。
Mattermostはセルフホスト可能なチームメッセージングプラットフォームです。製品の詳細とダウンロードについては、公式サイト
[mattermost.com](https://mattermost.com)をご覧ください。

## プラグインが必要です

Mattermostはプラグインとして提供されており、コアインストールにはバンドルされていません。

CLI経由でインストール（npmレジストリ）:

```bash
openclaw plugins install @openclaw/mattermost
```

ローカルチェックアウト（gitリポジトリから実行する場合）:

```bash
openclaw plugins install ./extensions/mattermost
```

設定/オンボーディング中にMattermostを選択し、gitチェックアウトが検出された場合、
OpenClawはローカルインストールパスを自動的に提案します。

詳細: [プラグイン](/tools/plugin)

## クイックセットアップ

1. Mattermostプラグインをインストールします。
2. Mattermostのボットアカウントを作成し、**ボットトークン**をコピーします。
3. Mattermostの**ベースURL**をコピーします（例: `https://chat.example.com`）。
4. OpenClawを設定し、Gatewayを起動します。

最小設定:

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## 環境変数（デフォルトアカウント）

環境変数を使用する場合は、Gatewayホストで以下を設定します:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

環境変数は**デフォルト**アカウント（`default`）にのみ適用されます。他のアカウントは設定値を使用する必要があります。

## チャットモード

MattermostはDMには自動的に応答します。チャンネルの動作は`chatmode`で制御されます:

- `oncall`（デフォルト）: チャンネルで@メンションされた場合のみ応答。
- `onmessage`: すべてのチャンネルメッセージに応答。
- `onchar`: メッセージがトリガープレフィックスで始まる場合に応答。

設定例:

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

注意:

- `onchar`でも明示的な@メンションには応答します。
- `channels.mattermost.requireMention`はレガシー設定で引き続き有効ですが、`chatmode`が推奨されます。

## アクセス制御（DM）

- デフォルト: `channels.mattermost.dmPolicy = "pairing"`（未知の送信者にはペアリングコードが提示されます）。
- 承認方法:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- パブリックDM: `channels.mattermost.dmPolicy="open"`に加えて`channels.mattermost.allowFrom=["*"]`。

## チャンネル（グループ）

- デフォルト: `channels.mattermost.groupPolicy = "allowlist"`（メンションゲーティング）。
- `channels.mattermost.groupAllowFrom`で送信者を許可リストに登録します（ユーザーID推奨）。
- `@username`マッチングはミュータブルであり、`channels.mattermost.dangerouslyAllowNameMatching: true`の場合のみ有効です。
- オープンチャンネル: `channels.mattermost.groupPolicy="open"`（メンションゲーティング）。
- ランタイムの注意: `channels.mattermost`が完全に欠けている場合、ランタイムはグループチェックに対して`groupPolicy="allowlist"`にフォールバックします（`channels.defaults.groupPolicy`が設定されていても）。

## 送信ターゲット

`openclaw message send`またはcron/ウェブフックで以下のターゲット形式を使用します:

- `channel:<id>` チャンネル向け
- `user:<id>` DM向け
- `@username` DM向け（Mattermost API経由で解決）

ベアIDはチャンネルとして扱われます。

## リアクション（メッセージツール）

- `message action=react`を`channel=mattermost`で使用します。
- `messageId`はMattermostの投稿IDです。
- `emoji`は`thumbsup`や`:+1:`のような名前を受け入れます（コロンはオプション）。
- `remove=true`（ブーリアン）でリアクションを削除します。
- リアクションの追加/削除イベントは、ルーティングされたエージェントセッションにシステムイベントとして転送されます。

例:

```
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup remove=true
```

設定:

- `channels.mattermost.actions.reactions`: リアクションアクションの有効/無効（デフォルトtrue）。
- アカウントごとのオーバーライド: `channels.mattermost.accounts.<id>.actions.reactions`。

## マルチアカウント

Mattermostは`channels.mattermost.accounts`で複数アカウントをサポートします:

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## トラブルシューティング

- チャンネルで返信がない: ボットがチャンネルにいることを確認し、メンションする（oncall）、トリガープレフィックスを使用する（onchar）、または`chatmode: "onmessage"`を設定してください。
- 認証エラー: ボットトークン、ベースURL、およびアカウントが有効であることを確認してください。
- マルチアカウントの問題: 環境変数は`default`アカウントにのみ適用されます。
