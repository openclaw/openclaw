---
summary: "Mattermost ボットのセットアップと OpenClaw の設定"
read_when:
  - Mattermost のセットアップ
  - Mattermost ルーティングのデバッグ
title: "Mattermost"
---

# Mattermost（プラグイン）

Status: supported via plugin (bot token + WebSocket events). チャンネル、グループ、DMに対応しています。
Mattermostはセルフホスティング可能なチームメッセージングプラットフォームです。製品の詳細とダウンロードについては、
[mattermost.com](https://mattermost.com)の公式サイトを参照してください。

## プラグインが必要

Mattermost はプラグインとして提供されており、コアインストールには同梱されていません。

CLI（npm レジストリ）からインストール:

```bash
openclaw plugins install @openclaw/mattermost
```

ローカルチェックアウト（git リポジトリから実行する場合）:

```bash
openclaw plugins install ./extensions/mattermost
```

configure／オンボーディング中に Mattermost を選択し、git のチェックアウトが検出されると、
OpenClaw はローカルインストールパスを自動的に提示します。

詳細: [Plugins](/tools/plugin)

## クイックセットアップ

1. Mattermost プラグインをインストールします。
2. Mattermost のボットアカウントを作成し、**ボットトークン**をコピーします。
3. Mattermost の **ベース URL** をコピーします（例: `https://chat.example.com`）。
4. OpenClaw を設定し、ゲートウェイを起動します。

最小構成:

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

環境変数を使用する場合は、ゲートウェイ ホストに次を設定してください:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

環境変数は **デフォルト** アカウント（`default`）にのみ適用されます。その他のアカウントは設定値を使用する必要があります。 他のアカウントでは設定値を使用する必要があります。

## チャットモード

最も重要なものはDMに自動的に反応します。 Mattermost はダイレクトメッセージに自動で応答します。チャンネルの動作は `chatmode` により制御されます:

- `oncall`（デフォルト）: チャンネルでは @メンションされた場合のみ応答します。
- `onmessage`: すべてのチャンネルメッセージに応答します。
- `onchar`: メッセージがトリガープレフィックスで始まる場合に応答します。

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

注記:

- `onchar` は明示的な @メンションには引き続き応答します。
- `channels.mattermost.requireMention` はレガシー設定では尊重されますが、`chatmode` の使用が推奨されます。

## アクセス制御（ダイレクトメッセージ）

- デフォルト: `channels.mattermost.dmPolicy = "pairing"`（不明な送信者にはペアリングコードが発行されます）。
- 承認方法:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- 公開 DM: `channels.mattermost.dmPolicy="open"` に加えて `channels.mattermost.allowFrom=["*"]`。

## チャンネル（グループ）

- デフォルト: `channels.mattermost.groupPolicy = "allowlist"`（メンション制御）。
- `channels.mattermost.groupAllowFrom` で送信者を許可リストに追加します（ユーザー ID または `@username`）。
- オープンチャンネル: `channels.mattermost.groupPolicy="open"`（メンション制御）。

## 送信配信のターゲット

`openclaw message send` または cron／webhook で次のターゲット形式を使用します:

- チャンネル: `channel:<id>`
- ダイレクトメッセージ: `user:<id>`
- ダイレクトメッセージ（Mattermost API 経由で解決）: `@username`

裸の ID はチャンネルとして扱われます。

## マルチアカウント

Mattermost は `channels.mattermost.accounts` 配下で複数アカウントをサポートします:

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

- チャンネルで返信がない場合: ボットがチャンネルに参加していることを確認し、@メンション（oncall）する、トリガープレフィックス（onchar）を使用する、または `chatmode: "onmessage"` を設定してください。
- 認証エラー: ボットトークン、ベース URL、アカウントが有効化されているかを確認してください。
- マルチアカウントの問題: 環境変数は `default` アカウントにのみ適用されます。
