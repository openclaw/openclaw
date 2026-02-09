---
summary: "ログの表示面、ファイルログ、WS ログのスタイル、コンソールの書式設定"
read_when:
  - ログ出力やフォーマットを変更する場合
  - CLI または ゲートウェイ の出力をデバッグする場合
title: "ログ"
---

# ログ

ユーザー向けの概要（CLI + Control UI + 設定）については、[/logging](/logging) を参照してください。

OpenClaw には 2 つのログ「表示面」があります。

- **コンソール出力**（ターミナル / Debug UI に表示される内容）。
- **ファイルログ**（JSON Lines）。ゲートウェイ のロガーによって書き込まれます。

## ファイルベースのロガー

- 既定のローテーションログファイルは `/tmp/openclaw/` 配下（1 日 1 ファイル）にあります: `openclaw-YYYY-MM-DD.log`
  - 日付は ゲートウェイ ホスト のローカルタイムゾーンを使用します。
- ログファイルのパスとレベルは `~/.openclaw/openclaw.json` で設定できます。
  - `logging.file`
  - `logging.level`

ファイル形式は 1 行につき 1 つの JSON オブジェクトです。

Control UI の Logs タブは、ゲートウェイ 経由でこのファイルを tail します（`logs.tail`）。
CLI でも同様に実行できます。
CLI は同じことができます:

```bash
openclaw logs --follow
```

**Verbose と ログレベル**

- **ファイルログ** は `logging.level` のみによって制御されます。
- `--verbose` は **コンソールの冗長度**（および WS ログスタイル）にのみ影響し、ファイルログのレベルは引き上げません。
- verbose のみの詳細をファイルログに記録するには、`logging.level` を `debug` または `trace` に設定してください。

## コンソールのキャプチャ

CLI は `console.log/info/warn/error/debug/trace` をキャプチャしてファイルログに書き込みつつ、stdout/stderr への出力は継続します。

コンソールの詳細度を個別に調整できます。

- `logging.consoleLevel`（既定: `info`）
- `logging.consoleStyle`（`pretty` | `compact` | `json`）

## ツール要約の編集

verbose なツール要約（例: `🛠️ Exec: ...`）は、コンソールストリームに到達する前に機密トークンをマスクできます。これは **ツール専用** であり、ファイルログは変更しません。 これは**tools-only** で、ファイルログは変更されません。

- `logging.redactSensitive`: `off` | `tools`（既定: `tools`）
- `logging.redactPatterns`: 正規表現文字列の配列（既定値を上書き）
  - 生の正規表現文字列（自動で `gi`）を使用するか、カスタムフラグが必要な場合は `/pattern/flags` を使用します。
  - マッチは、先頭 6 文字 + 末尾 4 文字を保持してマスクします（長さ >= 18）。それ以外は `***` になります。
  - 既定では、一般的なキー割り当て、CLI フラグ、JSON フィールド、Bearer ヘッダー、PEM ブロック、一般的なトークン接頭辞をカバーします。

## ゲートウェイ WebSocket ログ

ゲートウェイ は WebSocket プロトコルログを 2 つのモードで出力します。

- **通常モード（`--verbose` なし）**: 「重要な」RPC 結果のみを出力します。
  - エラー（`ok=false`）
  - 低速な呼び出し（既定のしきい値: `>= 50ms`）
  - パースエラー
- **Verbose モード（`--verbose`）**: すべての WS リクエスト / レスポンス通信を出力します。

### WS ログスタイル

`openclaw gateway` は、ゲートウェイ ごとのスタイル切り替えをサポートします。

- `--ws-log auto`（既定）: 通常モードは最適化され、verbose モードでは簡潔な出力を使用します。
- `--ws-log compact`: verbose 時に、対応するリクエスト / レスポンスをまとめた簡潔出力
- `--ws-log full`: verbose 時に、フレームごとの完全な出力
- `--compact`: `--ws-log compact` の別名

例:

```bash
# optimized (only errors/slow)
openclaw gateway

# show all WS traffic (paired)
openclaw gateway --verbose --ws-log compact

# show all WS traffic (full meta)
openclaw gateway --verbose --ws-log full
```

## コンソールの書式設定（サブシステム ログ）

コンソールフォーマッタは **TTY-aware** で、固定された線を出力します。
サブシステムロガーは出力をグループ化してスキャン可能にします。

動作:

- 各行に **サブシステムのプレフィックス**（例: `[gateway]`, `[canvas]`, `[tailscale]`）
- **サブシステムごとの色**（サブシステム単位で安定）に加え、レベル別の色分け
- **出力が TTY、またはリッチなターミナルと判断される環境の場合に着色**（`TERM`/`COLORTERM`/`TERM_PROGRAM`）。`NO_COLOR` を尊重します。
- **短縮されたサブシステム プレフィックス**: 先頭の `gateway/` + `channels/` を削除し、末尾 2 セグメントを保持（例: `whatsapp/outbound`）
- **サブシステム別のサブロガー**（自動プレフィックス + 構造化フィールド `{ subsystem }`）
- QR / UX 出力用の **`logRaw()`**（プレフィックスなし、書式設定なし）
- **コンソールスタイル**（例: `pretty | compact | json`）
- **コンソールのログレベル** はファイルログレベルと分離（`logging.level` を `debug`/`trace` に設定すると、ファイルは完全な詳細を保持）
- **WhatsApp のメッセージ本文** は `debug` でログされます（表示するには `--verbose` を使用）

これにより、既存のファイルログを安定したまま維持しつつ、対話的な出力をスキャンしやすくします。
