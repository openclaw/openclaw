---
summary: "チャンネル接続のヘルスチェック手順"
read_when:
  - Diagnosing WhatsApp channel health
title: "ヘルスチェック"
---

# ヘルスチェック（CLI）

推測せずにチャンネル接続を検証するための簡潔なガイドです。

## クイックチェック

- `openclaw status` -- ローカルサマリー：Gatewayの到達可能性/モード、更新ヒント、リンクされたチャンネル認証の経過時間、セッション + 最近のアクティビティ。
- `openclaw status --all` -- 完全なローカル診断（読み取り専用、カラー、デバッグ用に安全に貼り付け可能）。
- `openclaw status --deep` -- 実行中のGatewayもプローブします（サポートされている場合はチャンネルごとのプローブ）。
- `openclaw health --json` -- 実行中のGatewayに完全なヘルススナップショットを要求します（WS限定、直接Baileysソケットなし）。
- WhatsApp/WebChatでスタンドアロンメッセージとして`/status`を送信すると、エージェントを呼び出さずにステータス返信を取得できます。
- ログ：`/tmp/openclaw/openclaw-*.log`をテールし、`web-heartbeat`、`web-reconnect`、`web-auto-reply`、`web-inbound`でフィルタリングします。

## 詳細診断

- ディスク上の認証情報：`ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json`（mtimeが最近であるべき）。
- セッションストア：`ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json`（パスは設定でオーバーライド可能）。カウントと最近の受信者は`status`経由で表示されます。
- 再リンクフロー：ステータスコード409-515または`loggedOut`がログに表示された場合は`openclaw channels logout && openclaw channels login --verbose`。（注意：QRログインフローはペアリング後のステータス515に対して1回自動再起動します。）

## 何かが失敗した場合

- `logged out`またはステータス409-515 → `openclaw channels logout`してから`openclaw channels login`で再リンク。
- Gatewayに到達できない → 起動：`openclaw gateway --port 18789`（ポートがビジーな場合は`--force`を使用）。
- 受信メッセージなし → リンクされた電話がオンラインで送信者が許可されていることを確認（`channels.whatsapp.allowFrom`）。グループチャットの場合は、許可リスト + メンションルールが一致していることを確認（`channels.whatsapp.groups`、`agents.list[].groupChat.mentionPatterns`）。

## 専用「health」コマンド

`openclaw health --json`は実行中のGatewayにヘルススナップショットを要求します（CLIからの直接チャンネルソケットなし）。利用可能な場合はリンクされた認証情報/認証の経過時間、チャンネルごとのプローブサマリー、セッションストアサマリー、プローブ期間を報告します。Gatewayに到達できない場合やプローブが失敗/タイムアウトした場合は非ゼロで終了します。`--timeout <ms>`で10秒のデフォルトをオーバーライドできます。
