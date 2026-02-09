---
summary: "Nextcloud Talk のサポート状況、機能、および設定"
read_when:
  - Nextcloud Talk チャンネル機能の作業中
title: "Nextcloud Talk"
---

# Nextcloud Talk（プラグイン）

ステータス: プラグイン（Webhook ボット）経由でサポートされています。ダイレクトメッセージ、ルーム、リアクション、Markdown メッセージがサポートされています。 ダイレクトメッセージ、ルーム、リアクション、マークダウンメッセージに対応しています。

## プラグインが必要

Nextcloud Talk はプラグインとして提供されており、コアインストールには同梱されていません。

CLI（npm レジストリ）でインストール:

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

ローカルチェックアウト（git リポジトリから実行する場合）:

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

設定／オンボーディング中に Nextcloud Talk を選択し、git チェックアウトが検出された場合、
OpenClaw はローカルインストールパスを自動的に提示します。

詳細: [Plugins](/tools/plugin)

## クイックセットアップ（初心者向け）

1. Nextcloud Talk プラグインをインストールします。

2. Nextcloud サーバーでボットを作成します。

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. 対象ルームの設定でボットを有効化します。

4. OpenClaw を設定します:
   - 設定: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - または 環境変数: `NEXTCLOUD_TALK_BOT_SECRET`（デフォルトアカウントのみ）

5. ゲートウェイを再起動します（またはオンボーディングを完了します）。

最小構成:

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

## 注記

- ボットはDMを開始できません。 ボットはダイレクトメッセージを開始できません。ユーザーが先にボットへメッセージを送信する必要があります。
- Webhook URL は Gateway（ゲートウェイ）から到達可能である必要があります。プロキシ配下の場合は `webhookPublicUrl` を設定してください。
- ボット API ではメディアのアップロードはサポートされていません。メディアは URL として送信されます。
- Webhook ペイロードでは DM とルームを区別できません。ルームタイプの判定を有効にするには `apiUser` + `apiPassword` を設定してください（設定しない場合、DM はルームとして扱われます）。

## アクセス制御（DM）

- デフォルト: `channels.nextcloud-talk.dmPolicy = "pairing"`。不明な送信者にはペアリングコードが発行されます。 不明な送信者はペアリングコードを取得します。
- 承認方法:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- 公開 DM: `channels.nextcloud-talk.dmPolicy="open"` に加えて `channels.nextcloud-talk.allowFrom=["*"]`。
- `allowFrom` は Nextcloud のユーザー ID のみに一致します。表示名は無視されます。

## ルーム（グループ）

- デフォルト: `channels.nextcloud-talk.groupPolicy = "allowlist"`（メンション必須）。
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

- ルームを許可しない場合は、許可リストを空にするか `channels.nextcloud-talk.groupPolicy="disabled"` を設定してください。

## 機能

| 機能         | ステータス  |
| ---------- | ------ |
| ダイレクトメッセージ | サポート   |
| ルーム        | サポート   |
| スレッド       | 非サポート  |
| メディア       | URL のみ |
| Reactions  | サポート   |
| ネイティブコマンド  | 非サポート  |

## 設定リファレンス（Nextcloud Talk）

完全な設定: [Configuration](/gateway/configuration)

プロバイダーオプション:

- `channels.nextcloud-talk.enabled`: チャンネル起動の有効／無効。
- `channels.nextcloud-talk.baseUrl`: Nextcloud インスタンスの URL。
- `channels.nextcloud-talk.botSecret`: ボットの共有シークレット。
- `channels.nextcloud-talk.botSecretFile`: シークレットファイルのパス。
- `channels.nextcloud-talk.apiUser`: ルーム参照用 API ユーザー（DM 検出）。
- `channels.nextcloud-talk.apiPassword`: ルーム参照用 API／アプリパスワード。
- `channels.nextcloud-talk.apiPasswordFile`: API パスワードファイルのパス。
- `channels.nextcloud-talk.webhookPort`: Webhook リスナーポート（デフォルト: 8788）。
- `channels.nextcloud-talk.webhookHost`: Webhook ホスト（デフォルト: 0.0.0.0）。
- `channels.nextcloud-talk.webhookPath`: Webhook パス（デフォルト: /nextcloud-talk-webhook）。
- `channels.nextcloud-talk.webhookPublicUrl`: 外部から到達可能な Webhook URL。
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`。
- `channels.nextcloud-talk.allowFrom`: DM の許可リスト（ユーザー ID）。`open` には `"*"` が必要です。 `open`には`"*"`が必要です。
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`。
- `channels.nextcloud-talk.groupAllowFrom`: グループの許可リスト（ユーザー ID）。
- `channels.nextcloud-talk.rooms`: ルームごとの設定および許可リスト。
- `channels.nextcloud-talk.historyLimit`: グループの履歴上限（0 で無効）。
- `channels.nextcloud-talk.dmHistoryLimit`: DM の履歴上限（0 で無効）。
- `channels.nextcloud-talk.dms`: DM ごとの上書き設定（historyLimit）。
- `channels.nextcloud-talk.textChunkLimit`: 送信テキストのチャンクサイズ（文字数）。
- `channels.nextcloud-talk.chunkMode`: `length`（デフォルト）または `newline`。長さで分割する前に空行（段落境界）で分割します。
- `channels.nextcloud-talk.blockStreaming`: このチャンネルでブロックストリーミングを無効化します。
- `channels.nextcloud-talk.blockStreamingCoalesce`: ブロックストリーミングの結合調整。
- `channels.nextcloud-talk.mediaMaxMb`: 受信メディアの上限（MB）。
