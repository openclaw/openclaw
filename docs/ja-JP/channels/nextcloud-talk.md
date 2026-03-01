---
summary: "Nextcloud Talkのサポート状況、機能、設定"
read_when:
  - Nextcloud Talkチャンネル機能を作業するとき
title: "Nextcloud Talk"
---

# Nextcloud Talk（プラグイン）

ステータス: プラグインでサポート（ウェブフックボット）。ダイレクトメッセージ、ルーム、リアクション、Markdownメッセージがサポートされています。

## プラグインが必要です

Nextcloud Talkはプラグインとして提供されており、コアインストールにはバンドルされていません。

CLI経由でインストール（npmレジストリ）:

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

ローカルチェックアウト（gitリポジトリから実行する場合）:

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

設定/オンボーディング中にNextcloud Talkを選択し、gitチェックアウトが検出された場合、
OpenClawはローカルインストールパスを自動的に提案します。

詳細: [プラグイン](/tools/plugin)

## クイックセットアップ（初心者向け）

1. Nextcloud Talkプラグインをインストールします。
2. Nextcloudサーバーでボットを作成します:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. 対象ルームの設定でボットを有効にします。
4. OpenClawを設定します:
   - 設定: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - または環境変数: `NEXTCLOUD_TALK_BOT_SECRET`（デフォルトアカウントのみ）
5. Gatewayを再起動します（またはオンボーディングを完了します）。

最小設定:

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

- ボットはDMを開始できません。ユーザーが最初にボットにメッセージを送信する必要があります。
- ウェブフックURLはGatewayから到達可能である必要があります。プロキシの背後にある場合は`webhookPublicUrl`を設定してください。
- メディアアップロードはボットAPIでサポートされていません。メディアはURLとして送信されます。
- ウェブフックペイロードはDMとルームを区別しません。ルームタイプのルックアップを有効にするには`apiUser` + `apiPassword`を設定してください（そうでない場合、DMはルームとして扱われます）。

## アクセス制御（DM）

- デフォルト: `channels.nextcloud-talk.dmPolicy = "pairing"`。未知の送信者にはペアリングコードが提示されます。
- 承認方法:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- パブリックDM: `channels.nextcloud-talk.dmPolicy="open"`に加えて`channels.nextcloud-talk.allowFrom=["*"]`。
- `allowFrom`はNextcloudユーザーIDのみに一致します。表示名は無視されます。

## ルーム（グループ）

- デフォルト: `channels.nextcloud-talk.groupPolicy = "allowlist"`（メンションゲーティング）。
- `channels.nextcloud-talk.rooms`でルームを許可リストに登録:

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

- ルームを許可しない場合は、許可リストを空のままにするか、`channels.nextcloud-talk.groupPolicy="disabled"`を設定してください。

## 機能

| 機能         | ステータス        |
| --------------- | ------------- |
| ダイレクトメッセージ | サポート済み     |
| ルーム           | サポート済み     |
| スレッド         | 未サポート |
| メディア           | URLのみ      |
| リアクション       | サポート済み     |
| ネイティブコマンド | 未サポート |

## 設定リファレンス（Nextcloud Talk）

完全な設定: [設定](/gateway/configuration)

プロバイダーオプション:

- `channels.nextcloud-talk.enabled`: チャンネル起動の有効/無効。
- `channels.nextcloud-talk.baseUrl`: NextcloudインスタンスURL。
- `channels.nextcloud-talk.botSecret`: ボット共有シークレット。
- `channels.nextcloud-talk.botSecretFile`: シークレットファイルパス。
- `channels.nextcloud-talk.apiUser`: ルームルックアップ用のAPIユーザー（DM検出）。
- `channels.nextcloud-talk.apiPassword`: ルームルックアップ用のAPI/アプリパスワード。
- `channels.nextcloud-talk.apiPasswordFile`: APIパスワードファイルパス。
- `channels.nextcloud-talk.webhookPort`: ウェブフックリスナーポート（デフォルト: 8788）。
- `channels.nextcloud-talk.webhookHost`: ウェブフックホスト（デフォルト: 0.0.0.0）。
- `channels.nextcloud-talk.webhookPath`: ウェブフックパス（デフォルト: /nextcloud-talk-webhook）。
- `channels.nextcloud-talk.webhookPublicUrl`: 外部から到達可能なウェブフックURL。
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`。
- `channels.nextcloud-talk.allowFrom`: DM許可リスト（ユーザーID）。`open`には`"*"`が必要。
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`。
- `channels.nextcloud-talk.groupAllowFrom`: グループ許可リスト（ユーザーID）。
- `channels.nextcloud-talk.rooms`: ルームごとの設定と許可リスト。
- `channels.nextcloud-talk.historyLimit`: グループ履歴制限（0で無効）。
- `channels.nextcloud-talk.dmHistoryLimit`: DM履歴制限（0で無効）。
- `channels.nextcloud-talk.dms`: DMごとのオーバーライド（historyLimit）。
- `channels.nextcloud-talk.textChunkLimit`: 送信テキストチャンクサイズ（文字数）。
- `channels.nextcloud-talk.chunkMode`: `length`（デフォルト）または`newline`で空行（段落境界）で分割してから長さ分割。
- `channels.nextcloud-talk.blockStreaming`: このチャンネルのブロックストリーミングを無効化。
- `channels.nextcloud-talk.blockStreamingCoalesce`: ブロックストリーミング結合のチューニング。
- `channels.nextcloud-talk.mediaMaxMb`: 受信メディア上限（MB）。
