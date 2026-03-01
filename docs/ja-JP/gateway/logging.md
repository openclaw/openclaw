---
summary: "ロギングサーフェス、ファイルログ、WSログスタイル、コンソールフォーマット"
read_when:
  - Changing logging output or formats
  - Debugging CLI or gateway output
title: "ロギング"
---

# ロギング

ユーザー向けの概要（CLI + Control UI + 設定）については、[/logging](/logging)を参照してください。

OpenClawには2つのログ「サーフェス」があります：

- **コンソール出力**（ターミナル / Debug UIに表示されるもの）。
- **ファイルログ**（JSONライン）Gatewayロガーによって書き込まれます。

## ファイルベースのロガー

- デフォルトのローリングログファイルは`/tmp/openclaw/`配下にあります（1日1ファイル）：`openclaw-YYYY-MM-DD.log`
  - 日付はGatewayホストのローカルタイムゾーンを使用します。
- ログファイルのパスとレベルは`~/.openclaw/openclaw.json`で設定できます：
  - `logging.file`
  - `logging.level`

ファイル形式は1行1JSONオブジェクトです。

Control UIのLogsタブはGateway経由でこのファイルをテールします（`logs.tail`）。
CLIでも同じことができます：

```bash
openclaw logs --follow
```

**Verboseとログレベル**

- **ファイルログ**は`logging.level`のみで制御されます。
- `--verbose`は**コンソールの詳細度**（およびWSログスタイル）にのみ影響します。ファイルログレベルを上げることは**ありません**。
- verboseのみの詳細をファイルログに記録するには、`logging.level`を`debug`または`trace`に設定してください。

## コンソールキャプチャ

CLIは`console.log/info/warn/error/debug/trace`をキャプチャしてファイルログに書き込みますが、stdout/stderrへの出力も継続します。

コンソールの詳細度は独立して調整できます：

- `logging.consoleLevel`（デフォルト`info`）
- `logging.consoleStyle`（`pretty` | `compact` | `json`）

## ツールサマリーのリダクション

Verboseツールサマリー（例：`🛠️ Exec: ...`）はコンソールストリームに到達する前に機密トークンをマスクできます。これは**ツールのみ**であり、ファイルログは変更しません。

- `logging.redactSensitive`：`off` | `tools`（デフォルト：`tools`）
- `logging.redactPatterns`：正規表現文字列の配列（デフォルトをオーバーライド）
  - 生の正規表現文字列（自動`gi`）、またはカスタムフラグが必要な場合は`/pattern/flags`を使用します。
  - マッチは最初の6文字と最後の4文字を保持してマスクされます（長さ >= 18の場合）、それ以外は`***`です。
  - デフォルトは一般的なキー割り当て、CLIフラグ、JSONフィールド、Bearerヘッダー、PEMブロック、人気のあるトークンプレフィックスをカバーします。

## Gateway WebSocketログ

Gatewayは2つのモードでWebSocketプロトコルログを出力します：

- **通常モード（`--verbose`なし）**：「興味深い」RPCの結果のみを出力します：
  - エラー（`ok=false`）
  - 遅い呼び出し（デフォルトしきい値：`>= 50ms`）
  - パースエラー
- **Verboseモード（`--verbose`）**：すべてのWSリクエスト/レスポンストラフィックを出力します。

### WSログスタイル

`openclaw gateway`はGatewayごとのスタイルスイッチをサポートしています：

- `--ws-log auto`（デフォルト）：通常モードは最適化。Verboseモードはコンパクト出力を使用
- `--ws-log compact`：Verbose時にコンパクト出力（ペアのリクエスト/レスポンス）
- `--ws-log full`：Verbose時にフルのフレームごとの出力
- `--compact`：`--ws-log compact`のエイリアス

例：

```bash
# 最適化（エラー/遅い呼び出しのみ）
openclaw gateway

# すべてのWSトラフィックを表示（ペア）
openclaw gateway --verbose --ws-log compact

# すべてのWSトラフィックを表示（フルメタ）
openclaw gateway --verbose --ws-log full
```

## コンソールフォーマット（サブシステムロギング）

コンソールフォーマッターは**TTY対応**で、一貫したプレフィックス付きの行を出力します。
サブシステムロガーは出力をグループ化してスキャンしやすくします。

動作：

- すべての行に**サブシステムプレフィックス**（例：`[gateway]`、`[canvas]`、`[tailscale]`）
- **サブシステムカラー**（サブシステムごとに安定）+ レベルカラーリング
- **出力がTTYまたはリッチターミナル環境のときにカラー**（`TERM`/`COLORTERM`/`TERM_PROGRAM`）、`NO_COLOR`を尊重
- **短縮サブシステムプレフィックス**：先頭の`gateway/` + `channels/`を削除し、最後の2セグメントを保持（例：`whatsapp/outbound`）
- **サブシステムによるサブロガー**（自動プレフィックス + 構造化フィールド`{ subsystem }`）
- **`logRaw()`** QR/UX出力用（プレフィックスなし、フォーマットなし）
- **コンソールスタイル**（例：`pretty | compact | json`）
- **コンソールログレベル**はファイルログレベルとは別（`logging.level`が`debug`/`trace`に設定されている場合、ファイルは完全な詳細を保持）
- **WhatsAppメッセージ本文**は`debug`でログ出力されます（表示するには`--verbose`を使用）

これにより既存のファイルログを安定させながら、インタラクティブな出力をスキャンしやすくします。
