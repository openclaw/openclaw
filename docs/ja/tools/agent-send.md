---
summary: "直接 `openclaw agent` CLI 実行（任意の配信）"
read_when:
  - エージェント CLI エントリーポイントの追加または変更時
title: "エージェント送信"
---

# `openclaw agent`（直接エージェント実行）

`openclawエージェント`は、着信チャットメッセージを必要とせずにエージェントターンを1回実行します。
デフォルトでは、**ゲートウェイを通過**; `--local` を追加して、現在のマシンに埋め込まれた
ランタイムを強制します。

## 動作

- 必須: `--message <text>`
- セッションの選択:
  - `--to <dest>` がセッションキーを導出（グループ／チャンネルのターゲットは分離を維持し、ダイレクトチャットは `main` に集約）、**または**
  - `--session-id <id>` が ID により既存のセッションを再利用、**または**
  - `--agent <id>` が設定済みのエージェントを直接ターゲット（そのエージェントの `main` セッションキーを使用）
- 通常のインバウンド返信と同じ組み込みエージェントランタイムを実行します。
- Thinking／verbose フラグはセッションストアに保持されます。
- 出力:
  - 既定: 返信テキスト（+ `MEDIA:<url>` 行）を出力
  - `--json`: 構造化ペイロード + メタデータを出力
- `--deliver` + `--channel` により、チャンネルへの任意配信が可能（ターゲット形式は `openclaw message --target` に一致）。
- `--reply-channel`/`--reply-to`/`--reply-account` を使用して、セッションを変更せずに配信を上書きできます。

Gateway（ゲートウェイ）に到達できない場合、CLI は **フォールバック** してローカルの組み込み実行に切り替わります。

## 例

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## フラグ

- `--local`: ローカル実行（シェル内にモデルプロバイダーの API キーが必要）
- `--deliver`: 選択したチャンネルに返信を送信
- `--channel`: 配信チャンネル（`whatsapp|telegram|discord|googlechat|slack|signal|imessage`、既定: `whatsapp`）
- `--reply-to`: 配信ターゲットの上書き
- `--reply-channel`: 配信チャンネルの上書き
- `--reply-account`: 配信アカウント ID の上書き
- `--thinking <off|minimal|low|medium|high|xhigh>`: Thinking レベルを永続化（GPT-5.2 + Codex モデルのみ）
- `--verbose <on|full|off>`: verbose レベルを永続化
- `--timeout <seconds>`: エージェントのタイムアウトを上書き
- `--json`: 構造化 JSON を出力
