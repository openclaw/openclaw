---
read_when:
    - ロギング出力やフォーマットの変更時
    - CLIやGateway ゲートウェイの出力をデバッグする場合
summary: ロギングサーフェス、ファイルログ、WSログスタイル、コンソールフォーマット
title: Gateway ゲートウェイロギング
x-i18n:
    generated_at: "2026-04-02T07:42:50Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 465fe66ae6a3bc844e75d3898aed15b3371481c4fe89ede40e5a9377e19bb74c
    source_path: gateway/logging.md
    workflow: 15
---

# ロギング

ユーザー向けの概要（CLI＋コントロールUI＋設定）については、[/logging](/logging)を参照してください。

OpenClawには2つのログ「サーフェス」があります：

- **コンソール出力**（ターミナル / デバッグUIに表示されるもの）。
- **ファイルログ**（JSONライン）Gateway ゲートウェイロガーが書き出します。

## ファイルベースロガー

- デフォルトのローリングログファイルは`/tmp/openclaw/`配下にあります（1日1ファイル）：`openclaw-YYYY-MM-DD.log`
  - 日付はGateway ゲートウェイホストのローカルタイムゾーンを使用します。
- ログファイルのパスとレベルは`~/.openclaw/openclaw.json`で設定できます：
  - `logging.file`
  - `logging.level`

ファイル形式は1行につき1つのJSONオブジェクトです。

コントロールUIの「Logs」タブはGateway ゲートウェイ経由でこのファイルをtailします（`logs.tail`）。
CLIでも同様に実行できます：

```bash
openclaw logs --follow
```

**Verboseとログレベル**

- **ファイルログ**は`logging.level`のみで制御されます。
- `--verbose`は**コンソールの詳細度**（およびWSログスタイル）にのみ影響します。ファイルログレベルを引き上げることは**ありません**。
- verbose限定の詳細をファイルログに記録するには、`logging.level`を`debug`または`trace`に設定してください。

## コンソールキャプチャ

CLIは`console.log/info/warn/error/debug/trace`をキャプチャしてファイルログに書き出すと同時に、stdout/stderrにも出力します。

コンソールの詳細度は以下で独立して調整できます：

- `logging.consoleLevel`（デフォルト`info`）
- `logging.consoleStyle`（`pretty` | `compact` | `json`）

## ツールサマリーのリダクション

詳細なツールサマリー（例：`🛠️ Exec: ...`）は、コンソールストリームに出力される前に機密トークンをマスクできます。これは**ツール専用**であり、ファイルログは変更されません。

- `logging.redactSensitive`：`off` | `tools`（デフォルト：`tools`）
- `logging.redactPatterns`：正規表現文字列の配列（デフォルトをオーバーライド）
  - 生の正規表現文字列（自動`gi`）を使用するか、カスタムフラグが必要な場合は`/pattern/flags`を使用します。
  - マッチした部分は先頭6文字＋末尾4文字を残してマスクされます（長さ >= 18の場合）。それ以外は`***`になります。
  - デフォルトでは、一般的なキー代入、CLIフラグ、JSONフィールド、Bearerヘッダー、PEMブロック、および一般的なトークンプレフィックスをカバーします。

## Gateway ゲートウェイWebSocketログ

Gateway ゲートウェイはWebSocketプロトコルログを2つのモードで出力します：

- **通常モード（`--verbose`なし）**：「注目すべき」RPCの結果のみを出力：
  - エラー（`ok=false`）
  - 遅い呼び出し（デフォルトしきい値：`>= 50ms`）
  - パースエラー
- **Verboseモード（`--verbose`）**：すべてのWSリクエスト/レスポンストラフィックを出力。

### WSログスタイル

`openclaw gateway`はGateway ゲートウェイごとのスタイルスイッチをサポートします：

- `--ws-log auto`（デフォルト）：通常モードは最適化済み、verboseモードはコンパクト出力を使用
- `--ws-log compact`：verbose時にコンパクト出力（ペアのリクエスト/レスポンス）
- `--ws-log full`：verbose時にフルのフレーム単位出力
- `--compact`：`--ws-log compact`のエイリアス

例：

```bash
# 最適化（エラー/遅い呼び出しのみ）
openclaw gateway

# すべてのWSトラフィックを表示（ペア表示）
openclaw gateway --verbose --ws-log compact

# すべてのWSトラフィックを表示（フルメタ）
openclaw gateway --verbose --ws-log full
```

## コンソールフォーマット（サブシステムロギング）

コンソールフォーマッターは**TTY対応**で、一貫したプレフィックス付きの行を出力します。
サブシステムロガーは出力をグループ化し、スキャンしやすく保ちます。

動作：

- すべての行に**サブシステムプレフィックス**（例：`[gateway]`、`[canvas]`、`[tailscale]`）
- **サブシステムカラー**（サブシステムごとに安定）＋レベル色分け
- **出力がTTYまたはリッチターミナルに見える環境**（`TERM`/`COLORTERM`/`TERM_PROGRAM`）でカラー表示、`NO_COLOR`を尊重
- **短縮サブシステムプレフィックス**：先頭の`gateway/` + `channels/`を省略し、末尾2セグメントを保持（例：`whatsapp/outbound`）
- **サブシステムごとのサブロガー**（自動プレフィックス＋構造化フィールド`{ subsystem }`）
- **`logRaw()`**：QR/UX出力用（プレフィックスなし、フォーマットなし）
- **コンソールスタイル**（例：`pretty | compact | json`）
- **コンソールログレベル**はファイルログレベルとは分離（`logging.level`が`debug`/`trace`に設定されている場合、ファイルは完全な詳細を保持）
- **WhatsAppメッセージ本文**は`debug`で記録されます（表示するには`--verbose`を使用）

これにより既存のファイルログは安定したまま、インタラクティブな出力をスキャンしやすくします。
