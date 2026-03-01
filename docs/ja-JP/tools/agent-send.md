---
summary: "直接 `openclaw agent` CLIを実行する（配信オプション付き）"
read_when:
  - エージェントCLIエントリポイントの追加または変更時
title: "エージェント送信"
---

# `openclaw agent`（直接エージェント実行）

`openclaw agent` は、受信チャットメッセージを必要とせずに単一のエージェントターンを実行します。
デフォルトでは **Gateway を経由して** 実行されます。現在のマシン上の組み込みランタイムを強制するには `--local` を追加してください。

## 動作

- 必須: `--message <text>`
- セッション選択:
  - `--to <dest>` でセッションキーを導出します（グループ/チャンネルターゲットは隔離を維持し、ダイレクトチャットは `main` に集約されます）、**または**
  - `--session-id <id>` で既存のセッションをIDで再利用します、**または**
  - `--agent <id>` で設定済みのエージェントを直接ターゲットにします（そのエージェントの `main` セッションキーを使用）
- 通常の受信返信と同じ組み込みエージェントランタイムを実行します。
- thinking/verboseフラグはセッションストアに保存されます。
- 出力:
  - デフォルト: 返信テキスト（および `MEDIA:<url>` 行）を出力
  - `--json`: 構造化ペイロード＋メタデータを出力
- `--deliver` + `--channel` でチャンネルへの配信もオプションで可能です（ターゲット形式は `openclaw message --target` に対応）。
- `--reply-channel`/`--reply-to`/`--reply-account` でセッションを変更せずに配信先をオーバーライドできます。

Gateway に到達できない場合、CLIは組み込みのローカル実行に**フォールバック**します。

## 使用例

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## フラグ

- `--local`: ローカルで実行します（シェルにモデルプロバイダーAPIキーが必要）
- `--deliver`: 選択したチャンネルに返信を送信します
- `--channel`: 配信チャンネル（`whatsapp|telegram|discord|googlechat|slack|signal|imessage`、デフォルト: `whatsapp`）
- `--reply-to`: 配信ターゲットのオーバーライド
- `--reply-channel`: 配信チャンネルのオーバーライド
- `--reply-account`: 配信アカウントIDのオーバーライド
- `--thinking <off|minimal|low|medium|high|xhigh>`: thinkingレベルを保存します（GPT-5.2 + Codexモデルのみ）
- `--verbose <on|full|off>`: verboseレベルを保存します
- `--timeout <seconds>`: エージェントタイムアウトをオーバーライドします
- `--json`: 構造化JSONを出力します
