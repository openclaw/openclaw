---
summary: "チャンネルごとの障害シグネチャと修正方法に基づく、高速なチャンネルレベルのトラブルシューティング"
read_when:
  - チャンネルのトランスポートは「接続済み」と表示されるが、応答が失敗する場合
  - プロバイダーの詳細ドキュメントを深掘りする前に、チャンネル固有の確認が必要な場合
title: "チャンネルのトラブルシューティング"
---

# チャンネルのトラブルシューティング

チャンネルが接続されているにもかかわらず、動作が正しくない場合にこのページを使用します。

## コマンドラダー

まずは次の順番で実行してください。

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

健全なベースライン:

- `Runtime: running`
- `RPC probe: ok`
- チャンネルプローブが connected/ready を示している

## WhatsApp

### WhatsApp の障害シグネチャ

| 症状               | 最速の確認方法                                   | 修正方法                                 |
| ---------------- | ----------------------------------------- | ------------------------------------ |
| 接続済みだが DM に返信しない | `openclaw pairing list whatsapp`          | 送信者を承認するか、DM ポリシー／許可リストを切り替えます。      |
| グループメッセージが無視される  | 設定内の `requireMention` とメンションパターンを確認       | ボットをメンションするか、そのグループのメンションポリシーを緩和します。 |
| ランダムな切断／再ログインループ | `openclaw channels status --probe` とログを確認 | 再ログインし、認証情報ディレクトリが正常であることを確認します。     |

完全なトラブルシューティング: [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Telegram の障害シグネチャ

| 症状                     | 最速の確認方法                          | 修正方法                                             |
| ---------------------- | -------------------------------- | ------------------------------------------------ |
| `/start` だが有効な返信フローがない | `openclaw pairing list telegram` | ペアリングを承認するか、DM ポリシーを変更します。                       |
| ボットはオンラインだがグループが無言     | メンション要件とボットのプライバシーモードを確認         | グループ可視性のためにプライバシーモードを無効化するか、ボットをメンションします。        |
| ネットワークエラーで送信に失敗する      | Telegram API 呼び出し失敗のログを確認        | `api.telegram.org` への DNS/IPv6/プロキシルーティングを修正します。 |

完全なトラブルシューティング: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Discord の障害シグネチャ

| 症状                   | 最速の確認方法                            | 修正方法                                                    |
| -------------------- | ---------------------------------- | ------------------------------------------------------- |
| ボットはオンラインだがギルドに返信しない | `openclaw channels status --probe` | ギルド／チャンネルを許可し、メッセージ内容インテントを確認します。                       |
| グループメッセージが無視される      | メンションゲーティングのドロップがログに出ていないか確認       | ボットをメンションするか、ギルド／チャンネルの `requireMention: false` を設定します。 |
| DM の返信が欠落する          | `openclaw pairing list discord`    | DM ペアリングを承認するか、DM ポリシーを調整します。                           |

完全なトラブルシューティング: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Slack の障害シグネチャ

| 症状                  | 最速の確認方法                            | 修正方法                              |
| ------------------- | ---------------------------------- | --------------------------------- |
| ソケットモードは接続済みだが応答しない | `openclaw channels status --probe` | アプリトークンとボットトークン、および必要なスコープを確認します。 |
| DM がブロックされている       | `openclaw pairing list slack`      | ペアリングを承認するか、DM ポリシーを緩和します。        |
| チャンネルメッセージが無視される    | `groupPolicy` とチャンネル許可リストを確認       | チャンネルを許可するか、ポリシーを `open` に切り替えます。 |

完全なトラブルシューティング: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage と BlueBubbles

### iMessage と BlueBubbles の障害シグネチャ

| 症状                  | 最速の確認方法                                                                  | 修正方法                                       |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| 受信イベントがない           | Webhook／サーバーの到達性とアプリ権限を確認                                                | Webhook URL または BlueBubbles サーバーの状態を修正します。 |
| macOS で送信できるが受信できない | メッセージ自動化に関する macOS のプライバシー権限を確認                                          | TCC 権限を再付与し、チャンネルプロセスを再起動します。              |
| DM の送信者がブロックされている   | `openclaw pairing list imessage` または `openclaw pairing list bluebubbles` | ペアリングを承認するか、許可リストを更新します。                   |

完全なトラブルシューティング:

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### Signal の障害シグネチャ

| 症状                 | 最速の確認方法                            | 修正方法                                        |
| ------------------ | ---------------------------------- | ------------------------------------------- |
| デーモンには到達できるがボットが無言 | `openclaw channels status --probe` | `signal-cli` のデーモン URL／アカウントおよび受信モードを確認します。 |
| DM がブロックされている      | `openclaw pairing list signal`     | 送信者を承認するか、DM ポリシーを調整します。                    |
| グループ返信がトリガーされない    | グループ許可リストとメンションパターンを確認             | 送信者／グループを追加するか、ゲーティングを緩和します。                |

完全なトラブルシューティング: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## Matrix

### Matrix の障害シグネチャ

| 症状                    | 最速の確認方法                            | 修正方法                           |
| --------------------- | ---------------------------------- | ------------------------------ |
| ログイン済みだがルームメッセージを無視する | `openclaw channels status --probe` | `groupPolicy` とルーム許可リストを確認します。 |
| DM が処理されない            | `openclaw pairing list matrix`     | 送信者を承認するか、DM ポリシーを調整します。       |
| 暗号化ルームで失敗する           | 暗号化モジュールと暗号化設定を確認                  | 暗号化サポートを有効化し、ルームに再参加／再同期します。   |

完全なトラブルシューティング: [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
