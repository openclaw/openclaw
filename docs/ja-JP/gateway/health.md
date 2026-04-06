---
read_when:
    - チャネル接続性やGateway ゲートウェイのヘルス診断時
    - ヘルスチェックCLIコマンドとオプションの理解
summary: ヘルスチェックコマンドとGateway ゲートウェイのヘルスモニタリング
title: ヘルスチェック
x-i18n:
    generated_at: "2026-04-02T07:41:51Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 5dca652cbd346abc7ab36135436b224e08fc056656517651126a2e188d4f21c0
    source_path: gateway/health.md
    workflow: 15
---

# ヘルスチェック（CLI）

推測なしでチャネル接続性を検証するための簡易ガイドです。

## クイックチェック

- `openclaw status` — ローカルサマリー：Gateway ゲートウェイの到達性/モード、更新ヒント、リンク済みチャネルの認証経過時間、セッション＋最近のアクティビティ。
- `openclaw status --all` — 完全なローカル診断（読み取り専用、カラー表示、デバッグ用に貼り付け可能）。
- `openclaw status --deep` — 実行中のGateway ゲートウェイもプローブします（サポートされている場合はチャネルごとのプローブ）。
- `openclaw health --json` — 実行中のGateway ゲートウェイに完全なヘルススナップショットを要求します（WSのみ、直接のBaileysソケットなし）。
- WhatsApp/WebChatで単独メッセージとして`/status`を送信すると、エージェントを呼び出さずにステータス返信を取得できます。
- ログ：`/tmp/openclaw/openclaw-*.log`をtailし、`web-heartbeat`、`web-reconnect`、`web-auto-reply`、`web-inbound`でフィルタリングします。

## 詳細診断

- ディスク上の資格情報：`ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json`（mtimeが最近であるべきです）。
- セッションストア：`ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json`（パスは設定でオーバーライド可能）。件数と最近の送信先は`status`で表示されます。
- 再リンクフロー：ログにステータスコード409〜515または`loggedOut`が表示された場合、`openclaw channels logout && openclaw channels login --verbose`を実行します。（注意：QRログインフローはペアリング後のステータス515に対して1回自動リスタートします。）

## ヘルスモニター設定

- `gateway.channelHealthCheckMinutes`：Gateway ゲートウェイがチャネルヘルスをチェックする頻度。デフォルト：`5`。`0`に設定するとヘルスモニターによるリスタートをグローバルに無効化します。
- `gateway.channelStaleEventThresholdMinutes`：接続済みチャネルがアイドル状態のまま、ヘルスモニターが古いと判断してリスタートするまでの時間。デフォルト：`30`。`gateway.channelHealthCheckMinutes`以上に設定してください。
- `gateway.channelMaxRestartsPerHour`：チャネル/アカウントごとのヘルスモニターによるリスタートの1時間あたりのローリング上限。デフォルト：`10`。
- `channels.<provider>.healthMonitor.enabled`：グローバルモニタリングを有効にしたまま、特定のチャネルのヘルスモニターリスタートを無効化します。
- `channels.<provider>.accounts.<accountId>.healthMonitor.enabled`：チャネルレベルの設定に優先するマルチアカウントオーバーライド。
- これらのチャネルごとのオーバーライドは、現在公開されている組み込みチャネルモニターに適用されます：Discord、Google Chat、iMessage、Microsoft Teams、Signal、Slack、Telegram、およびWhatsApp。

## 何かが失敗した場合

- `logged out`またはステータス409〜515 → `openclaw channels logout`の後に`openclaw channels login`で再リンクします。
- Gateway ゲートウェイに到達不能 → 起動します：`openclaw gateway --port 18789`（ポートが使用中の場合は`--force`を使用）。
- 受信メッセージがない → リンクされた電話がオンラインで、送信者が許可されていることを確認します（`channels.whatsapp.allowFrom`）。グループチャットの場合、許可リスト＋メンションルールが一致していることを確認します（`channels.whatsapp.groups`、`agents.list[].groupChat.mentionPatterns`）。

## 専用「health」コマンド

`openclaw health --json`は実行中のGateway ゲートウェイにヘルススナップショットを要求します（CLIからの直接チャネルソケットなし）。利用可能な場合はリンク済みの資格情報/認証経過時間、チャネルごとのプローブサマリー、セッションストアサマリー、プローブ所要時間を報告します。Gateway ゲートウェイに到達不能、またはプローブが失敗/タイムアウトした場合は非ゼロで終了します。

オプション：

- `--json`：機械可読なJSON出力
- `--timeout <ms>`：デフォルトの10秒プローブタイムアウトをオーバーライド
- `--probe`：キャッシュされたヘルススナップショットを返す代わりに、すべてのチャネルのライブプローブを強制実行

ヘルススナップショットには以下が含まれます：`ok`（ブール値）、`ts`（タイムスタンプ）、`durationMs`（プローブ時間）、チャネルごとのステータス、エージェントの可用性、およびセッションストアサマリー。
