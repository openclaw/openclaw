---
read_when:
    - Mac アプリのヘルスインジケーターのデバッグ時
summary: macOS アプリが Gateway ゲートウェイ/Baileys のヘルス状態をどのように報告するか
title: ヘルスチェック（macOS）
x-i18n:
    generated_at: "2026-04-02T07:47:46Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: f9223b2bbe272b32526f79cf878510ac5104e788402d94a1b1627e72c5fbebf5
    source_path: platforms/mac/health.md
    workflow: 15
---

# macOS でのヘルスチェック

メニューバーアプリからリンクされたチャネルが正常かどうかを確認する方法です。

## メニューバー

- ステータスドットが Baileys のヘルスを反映するようになりました:
  - 緑: リンク済み + ソケットが最近開かれた。
  - オレンジ: 接続中/リトライ中。
  - 赤: ログアウト済みまたはプローブ失敗。
- 二次行に「linked · auth 12m」と表示されるか、失敗理由が表示されます。
- 「Run Health Check」メニュー項目でオンデマンドプローブをトリガーします。

## 設定

- 「General」タブにヘルスカードが追加され、リンク済み認証の経過時間、セッションストアのパス/数、最終チェック時刻、最終エラー/ステータスコード、「Run Health Check」/「Reveal Logs」ボタンが表示されます。
- キャッシュされたスナップショットを使用するため UI は即座に読み込まれ、オフライン時もグレースフルにフォールバックします。
- **「Channels」タブ**には WhatsApp/Telegram のチャネルステータスとコントロール（ログイン QR、ログアウト、プローブ、最終切断/エラー）が表示されます。

## プローブの仕組み

- アプリは `ShellExecutor` 経由で約60秒ごと、およびオンデマンドで `openclaw health --json` を実行します。プローブは認証情報を読み込み、メッセージを送信せずにステータスを報告します。
- ちらつきを避けるため、最後の正常なスナップショットと最後のエラーを別々にキャッシュし、それぞれのタイムスタンプを表示します。

## 判断に迷った場合

- [Gateway ゲートウェイヘルス](/gateway/health)の CLI フロー（`openclaw status`、`openclaw status --deep`、`openclaw health --json`）を引き続き使用でき、`/tmp/openclaw/openclaw-*.log` で `web-heartbeat` / `web-reconnect` を tail できます。
