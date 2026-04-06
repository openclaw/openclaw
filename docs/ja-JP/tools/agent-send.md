---
read_when:
    - スクリプトやコマンドラインからエージェントの実行をトリガーしたい
    - エージェントの返信をプログラム的にチャットチャネルに配信する必要がある
summary: CLIからエージェントターンを実行し、オプションでチャネルに返信を配信する
title: Agent Send
x-i18n:
    generated_at: "2026-04-02T08:39:07Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 42ea2977e89fb28d2afd07e5f6b1560ad627aea8b72fde36d8e324215c710afc
    source_path: tools/agent-send.md
    workflow: 15
---

# Agent Send

`openclaw agent` は、受信チャットメッセージを必要とせずにコマンドラインから単一のエージェントターンを実行します。スクリプトワークフロー、テスト、プログラム的な配信に使用します。

## クイックスタート

<Steps>
  <Step title="シンプルなエージェントターンを実行する">
    ```bash
    openclaw agent --message "What is the weather today?"
    ```

    これはメッセージをGateway ゲートウェイ経由で送信し、返信を出力します。

  </Step>

  <Step title="特定のエージェントまたはセッションを指定する">
    ```bash
    # 特定のエージェントを指定
    openclaw agent --agent ops --message "Summarize logs"

    # 電話番号を指定（セッションキーを導出）
    openclaw agent --to +15555550123 --message "Status update"

    # 既存のセッションを再利用
    openclaw agent --session-id abc123 --message "Continue the task"
    ```

  </Step>

  <Step title="返信をチャネルに配信する">
    ```bash
    # WhatsAppに配信（デフォルトチャネル）
    openclaw agent --to +15555550123 --message "Report ready" --deliver

    # Slackに配信
    openclaw agent --agent ops --message "Generate report" \
      --deliver --reply-channel slack --reply-to "#reports"
    ```

  </Step>
</Steps>

## フラグ

| フラグ                          | 説明                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| `--message \<text\>`          | 送信するメッセージ（必須）                                  |
| `--to \<dest\>`               | ターゲット（電話番号、チャットID）からセッションキーを導出           |
| `--agent \<id\>`              | 設定済みのエージェントを指定（その `main` セッションを使用）         |
| `--session-id \<id\>`         | 既存のセッションをIDで再利用                             |
| `--local`                     | ローカル組み込みランタイムを強制（Gateway ゲートウェイをスキップ）                 |
| `--deliver`                   | 返信をチャットチャネルに送信                            |
| `--channel \<name\>`          | 配信チャネル（whatsapp、telegram、discord、slackなど） |
| `--reply-to \<target\>`       | 配信先のオーバーライド                                    |
| `--reply-channel \<name\>`    | 配信チャネルのオーバーライド                                   |
| `--reply-account \<id\>`      | 配信アカウントIDのオーバーライド                                |
| `--thinking \<level\>`        | 思考レベルを設定（off、minimal、low、medium、high、xhigh） |
| `--verbose \<on\|full\|off\>` | 詳細レベルを設定                                           |
| `--timeout \<seconds\>`       | エージェントのタイムアウトをオーバーライド                                      |
| `--json`                      | 構造化JSONを出力                                      |

## 動作

- デフォルトでは、CLIは**Gateway ゲートウェイを経由**します。現在のマシンで組み込みランタイムを強制するには `--local` を追加してください。
- Gateway ゲートウェイに到達できない場合、CLIはローカル組み込み実行に**フォールバック**します。
- セッション選択: `--to` はセッションキーを導出します（グループ/チャネルターゲットは分離を維持し、ダイレクトチャットは `main` に集約されます）。
- 思考レベルと詳細フラグはセッションストアに永続化されます。
- 出力: デフォルトではプレーンテキスト、または `--json` で構造化ペイロード+メタデータ。

## 例

```bash
# JSON出力によるシンプルなターン
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json

# 思考レベルを指定したターン
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium

# セッションとは異なるチャネルに配信
openclaw agent --agent ops --message "Alert" --deliver --reply-channel telegram --reply-to "@admin"
```

## 関連

- [Agent CLIリファレンス](/cli/agent)
- [サブエージェント](/tools/subagents) — バックグラウンドでのサブエージェント起動
- [セッション](/concepts/session) — セッションキーの仕組み
