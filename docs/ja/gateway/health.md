---
summary: "チャンネル接続性のためのヘルスチェック手順"
read_when:
  - WhatsApp チャンネルのヘルスを診断する場合
title: "ヘルスチェック"
---

# ヘルスチェック（CLI）

推測に頼らずにチャンネル接続性を検証するための簡潔なガイドです。

## クイックチェック

- `openclaw status` — ローカル要約：ゲートウェイの到達性／モード、更新ヒント、リンク済みチャンネルの認証経過時間、セッションと最近のアクティビティ。
- `openclaw status --all` — 完全なローカル診断（読み取り専用、カラー表示、デバッグ用途でそのまま貼り付け可能）。
- `openclaw status --deep` — 実行中の Gateway（ゲートウェイ）もプローブします（対応している場合はチャンネル別プローブ）。
- `openclaw health --json` — 実行中の Gateway（ゲートウェイ）に完全なヘルススナップショットを要求します（WS のみ；直接の Baileys ソケットは使用しません）。
- WhatsApp／WebChat で `/status` を単独メッセージとして送信すると、エージェントを起動せずにステータス応答を取得できます。
- ログ：`/tmp/openclaw/openclaw-*.log` を tail し、`web-heartbeat`、`web-reconnect`、`web-auto-reply`、`web-inbound` でフィルタリングします。

## 詳細診断

- ディスク上の認証情報：`ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json`（mtime は最近である必要があります）。
- セッションストア：`ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json`（パスは設定で上書き可能）。件数と最近の受信者は `status` で表示されます。 カウントと最近の受信者は `status` で表示されます。
- 再リンクフロー：ログにステータスコード 409–515 または `loggedOut` が表示された場合は `openclaw channels logout && openclaw channels login --verbose` を実行します。（注：QR ログインフローは、ペアリング後にステータス 515 の場合は一度だけ自動再起動します。） (注:QRログインフローはペアリング後の状態515で一度自動的に再起動します。

## 問題が発生した場合

- `logged out` またはステータス 409–515 → `openclaw channels logout` で再リンクし、その後 `openclaw channels login` を実行します。
- Gateway（ゲートウェイ）に到達できない → 起動します：`openclaw gateway --port 18789`（ポートが使用中の場合は `--force` を使用）。
- 受信メッセージがない → リンクされた電話がオンラインであること、送信者が許可されていること（`channels.whatsapp.allowFrom`）を確認します。グループチャットの場合は、許可リストとメンションのルールが一致していること（`channels.whatsapp.groups`、`agents.list[].groupChat.mentionPatterns`）を確認してください。

## 専用の「health」コマンド

`openclaw health --json` は、実行中の Gateway（ゲートウェイ）にヘルススナップショットを要求します（CLI から直接チャンネルソケットには接続しません）。利用可能な場合は、リンク済み認証情報／認証経過時間、チャンネル別プローブ要約、セッションストア要約、プローブ所要時間を報告します。Gateway（ゲートウェイ）に到達できない場合、またはプローブが失敗／タイムアウトした場合は非ゼロで終了します。既定の 10 秒を上書きするには `--timeout <ms>` を使用してください。 チャネルごとのプローブサマリー、セッションストアサマリー、プローブ期間が利用可能な場合、リンクされたクレジット/認証年齢、およびプローブ期間が報告されます。 ゲートウェイに到達できない場合、またはプローブが失敗/タイムアウトする場合、ゼロ以外は終了します。 `--timeout <ms>` を使用して、10のデフォルトを上書きします。
