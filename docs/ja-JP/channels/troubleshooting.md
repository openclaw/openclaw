---
summary: "チャンネルごとの障害シグネチャと修正を含む高速チャンネルレベルのトラブルシューティング"
read_when:
  - チャンネルトランスポートが接続済みと表示されるが返信が失敗するとき
  - プロバイダーの詳細ドキュメントを確認する前にチャンネル固有のチェックが必要なとき
title: "チャンネルのトラブルシューティング"
---

# チャンネルのトラブルシューティング

チャンネルは接続されているが動作が正しくない場合にこのページを使用してください。

## コマンドラダー

まず以下を順番に実行してください:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

正常なベースライン:

- `Runtime: running`
- `RPC probe: ok`
- チャンネルプローブがconnected/readyを表示

## WhatsApp

### WhatsAppの障害シグネチャ

| 症状                         | 最速の確認方法                                       | 修正方法                                                     |
| ----------------------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| 接続済みだがDMの返信がない     | `openclaw pairing list whatsapp`                    | 送信者を承認するか、DMポリシー/許可リストを切り替えます。     |
| グループメッセージが無視される | 設定の`requireMention` + メンションパターンを確認   | ボットにメンションするか、そのグループのメンションポリシーを緩和します。 |
| ランダムな切断/再ログインループ | `openclaw channels status --probe` + ログ           | 再ログインして資格情報ディレクトリが正常であることを確認します。   |

詳細なトラブルシューティング: [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Telegramの障害シグネチャ

| 症状                           | 最速の確認方法                                   | 修正方法                                                                         |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `/start`後に使用可能な返信フローがない | `openclaw pairing list telegram`                | ペアリングを承認するか、DMポリシーを変更します。                                        |
| ボットはオンラインだがグループが無反応 | メンション要件とボットプライバシーモードを確認   | グループの可視性のためにプライバシーモードを無効にするか、ボットにメンションします。           |
| ネットワークエラーでの送信失敗   | Telegram APIコールの失敗をログで確認             | `api.telegram.org`へのDNS/IPv6/プロキシルーティングを修正します。                       |
| アップグレード後に許可リストがブロック | `openclaw security audit`と設定の許可リスト     | `openclaw doctor --fix`を実行するか、`@username`を数値の送信者IDに置き換えます。 |

詳細なトラブルシューティング: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Discordの障害シグネチャ

| 症状                         | 最速の確認方法                       | 修正方法                                                       |
| ----------------------------- | ----------------------------------- | ------------------------------------------------------------- |
| ボットはオンラインだがギルドの返信がない | `openclaw channels status --probe`  | ギルド/チャンネルを許可し、メッセージコンテンツインテントを確認します。    |
| グループメッセージが無視される | メンションゲーティングのドロップをログで確認 | ボットにメンションするか、ギルド/チャンネルの`requireMention: false`を設定します。 |
| DM返信が欠落                 | `openclaw pairing list discord`     | DMペアリングを承認するか、DMポリシーを調整します。                   |

詳細なトラブルシューティング: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Slackの障害シグネチャ

| 症状                                | 最速の確認方法                             | 修正方法                                               |
| ------------------------------------ | ----------------------------------------- | ----------------------------------------------------- |
| ソケットモード接続済みだが応答なし    | `openclaw channels status --probe`        | アプリトークン + ボットトークンと必要なスコープを確認します。 |
| DMがブロックされている               | `openclaw pairing list slack`             | ペアリングを承認するか、DMポリシーを緩和します。               |
| チャンネルメッセージが無視される       | `groupPolicy`とチャンネル許可リストを確認 | チャンネルを許可するか、ポリシーを`open`に切り替えます。     |

詳細なトラブルシューティング: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessageとBlueBubbles

### iMessageとBlueBubblesの障害シグネチャ

| 症状                          | 最速の確認方法                                                           | 修正方法                                                   |
| ------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| 受信イベントなし                | ウェブフック/サーバーの到達可能性とアプリ権限を確認                        | ウェブフックURLまたはBlueBubblesサーバーの状態を修正します。          |
| macOSで送信はできるが受信できない | MessagesオートメーションのmacOSプライバシー権限を確認                      | TCC権限を再付与し、チャンネルプロセスを再起動します。 |
| DMの送信者がブロックされている   | `openclaw pairing list imessage`または`openclaw pairing list bluebubbles` | ペアリングを承認するか、許可リストを更新します。                  |

詳細なトラブルシューティング:

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### Signalの障害シグネチャ

| 症状                         | 最速の確認方法                              | 修正方法                                                      |
| ----------------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| デーモンは到達可能だがボットが無反応 | `openclaw channels status --probe`         | `signal-cli`デーモンのURL/アカウントと受信モードを確認します。 |
| DMがブロックされている         | `openclaw pairing list signal`             | 送信者を承認するか、DMポリシーを調整します。                      |
| グループ返信がトリガーされない   | グループ許可リストとメンションパターンを確認 | 送信者/グループを追加するか、ゲーティングを緩和します。                       |

詳細なトラブルシューティング: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## Matrix

### Matrixの障害シグネチャ

| 症状                             | 最速の確認方法                                | 修正方法                                             |
| --------------------------------- | -------------------------------------------- | --------------------------------------------------- |
| ログイン済みだがルームメッセージが無視される | `openclaw channels status --probe`           | `groupPolicy`とルーム許可リストを確認します。         |
| DMが処理されない                  | `openclaw pairing list matrix`               | 送信者を承認するか、DMポリシーを調整します。             |
| 暗号化されたルームが失敗する       | 暗号化モジュールと暗号化設定を確認           | 暗号化サポートを有効にし、ルームを再参加/同期します。 |

詳細なトラブルシューティング: [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
