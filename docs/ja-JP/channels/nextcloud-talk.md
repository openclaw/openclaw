---
summary: "Nextcloud Talk のサポートステータス、ケイパビリティ、および設定"
read_when:
  - Nextcloud Talk チャンネル機能に取り組む場合
title: "Nextcloud Talk"
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 114764c4cba22c011874ff3ec58427cf306cc865eb1ac5fbc3d298d0fefb800e
    source_path: channels/nextcloud-talk.md
    workflow: 15
---

# Nextcloud Talk（プラグイン）

ステータス: プラグイン経由でサポートされています（Webhook ボット）。ダイレクトメッセージ、ルーム、リアクション、Markdown メッセージがサポートされています。

## プラグインが必要

Nextcloud Talk はプラグインとして提供されており、コアインストールにはバンドルされていません。

CLI 経由でインストール（npm レジストリ）:

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

ローカルチェックアウト（git リポジトリから実行する場合）:

```bash
openclaw plugins install ./path/to/local/nextcloud-talk-plugin
```

セットアップ時に Nextcloud Talk を選択し、git チェックアウトが検出された場合、
OpenClaw は自動的にローカルインストールパスを提案します。

詳細: [Plugins](/tools/plugin)

## クイックセットアップ（初心者向け）

1. Nextcloud Talk プラグインをインストールします。
2. Nextcloud サーバーでボットを作成します:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. ターゲットルームの設定でボットを有効にします。
4. OpenClaw を設定します:
   - 設定: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - または環境変数: `NEXTCLOUD_TALK_BOT_SECRET`（デフォルトアカウントのみ）
5. Gateway ゲートウェイを再起動します（またはセットアップを終了します）。

最小限の設定:

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## 注意事項

- ボットは DM を開始できません。ユーザーが最初にボットにメッセージを送る必要があります。
- Webhook URL は Gateway ゲートウェイから到達可能である必要があります。プロキシの後ろにある場合は `webhookPublicUrl` を設定してください。
- ボット API ではメディアのアップロードはサポートされていません。メディアは URL として送信されます。
- Webhook ペイロードは DM とルームを区別しません。DM 検出のためにルームタイプのルックアップを有効にするには `apiUser` + `apiPassword` を設定してください（設定しない場合、DM はルームとして扱われます）。

## アクセス制御（DM）

- デフォルト: `channels.nextcloud-talk.dmPolicy = "pairing"`。未知の送信者にはペアリングコードが届きます。
- 以下で承認します:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- 公開 DM: `channels.nextcloud-talk.dmPolicy="open"` と `channels.nextcloud-talk.allowFrom=["*"]`。
- `allowFrom` は Nextcloud ユーザー ID のみに一致します。表示名は無視されます。

## ルーム（グループ）

- デフォルト: `channels.nextcloud-talk.groupPolicy = "allowlist"`（メンションゲート付き）。
- `channels.nextcloud-talk.rooms` でルームを許可リストに追加します:

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- ルームを許可しない場合は、許可リストを空のままにするか `channels.nextcloud-talk.groupPolicy="disabled"` を設定してください。

## ケイパビリティ

| 機能             | ステータス       |
| --------------- | ------------- |
| ダイレクトメッセージ | サポート済み     |
| ルーム           | サポート済み     |
| スレッド          | 未サポート       |
| メディア          | URL のみ       |
| リアクション       | サポート済み     |
| ネイティブコマンド  | 未サポート       |

## 設定リファレンス（Nextcloud Talk）

完全な設定: [Configuration](/gateway/configuration)

プロバイダーオプション:

- `channels.nextcloud-talk.enabled`: チャンネルの起動を有効/無効にします。
- `channels.nextcloud-talk.baseUrl`: Nextcloud インスタンス URL。
- `channels.nextcloud-talk.botSecret`: ボット共有シークレット。
- `channels.nextcloud-talk.botSecretFile`: 通常ファイルのシークレットパス。シンボリックリンクは拒否されます。
- `channels.nextcloud-talk.apiUser`: ルームルックアップ用の API ユーザー（DM 検出）。
- `channels.nextcloud-talk.apiPassword`: ルームルックアップ用の API/アプリパスワード。
- `channels.nextcloud-talk.apiPasswordFile`: API パスワードファイルパス。
- `channels.nextcloud-talk.webhookPort`: Webhook リスナーポート（デフォルト: 8788）。
- `channels.nextcloud-talk.webhookHost`: Webhook ホスト（デフォルト: 0.0.0.0）。
- `channels.nextcloud-talk.webhookPath`: Webhook パス（デフォルト: /nextcloud-talk-webhook）。
- `channels.nextcloud-talk.webhookPublicUrl`: 外部から到達可能な Webhook URL。
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`。
- `channels.nextcloud-talk.allowFrom`: DM 許可リスト（ユーザー ID）。`open` には `"*"` が必要です。
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`。
- `channels.nextcloud-talk.groupAllowFrom`: グループ許可リスト（ユーザー ID）。
- `channels.nextcloud-talk.rooms`: ルームごとの設定と許可リスト。
- `channels.nextcloud-talk.historyLimit`: グループ履歴制限（0 で無効）。
- `channels.nextcloud-talk.dmHistoryLimit`: DM 履歴制限（0 で無効）。
- `channels.nextcloud-talk.dms`: DM ごとの上書き（historyLimit）。
- `channels.nextcloud-talk.textChunkLimit`: アウトバウンドテキストチャンクサイズ（文字単位）。
- `channels.nextcloud-talk.chunkMode`: `length`（デフォルト）または `newline`（長さチャンク処理前に空白行（段落区切り）で分割）。
- `channels.nextcloud-talk.blockStreaming`: このチャンネルのブロックストリーミングを無効にします。
- `channels.nextcloud-talk.blockStreamingCoalesce`: ブロックストリーミングの合体チューニング。
- `channels.nextcloud-talk.mediaMaxMb`: インバウンドメディアキャップ（MB）。

## 関連項目

- [Channels Overview](/channels) — サポートされているすべてのチャンネル
- [Pairing](/channels/pairing) — DM 認証とペアリングフロー
- [Groups](/channels/groups) — グループチャットの動作とメンションゲート
- [Channel Routing](/channels/channel-routing) — メッセージのセッションルーティング
- [Security](/gateway/security) — アクセスモデルとハードニング
