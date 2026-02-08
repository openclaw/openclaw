---
summary: "OpenClaw のログ：ローテーションする診断ファイルログと統合ログのプライバシーフラグ"
read_when:
  - macOS のログを取得する場合、またはプライベートデータのログ記録を調査する場合
  - 音声ウェイク／セッションのライフサイクルに関する問題をデバッグする場合
title: "macOS のログ記録"
x-i18n:
  source_path: platforms/mac/logging.md
  source_hash: c4c201d154915e0e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:22:38Z
---

# ログ記録（macOS）

## ローテーションする診断ファイルログ（Debug ペイン）

OpenClaw は macOS アプリのログを swift-log（既定では統合ログ）経由で出力し、耐久的な取得が必要な場合には、ローカルでローテーションするファイルログをディスクに書き込めます。

- 冗長度：**Debug ペイン → Logs → App logging → Verbosity**
- 有効化：**Debug ペイン → Logs → App logging → 「Write rolling diagnostics log (JSONL)」**
- 保存先：`~/Library/Logs/OpenClaw/diagnostics.jsonl`（自動でローテーションします。古いファイルには `.1`、`.2`、… のサフィックスが付きます）
- クリア：**Debug ペイン → Logs → App logging → 「Clear」**

注記：

- 既定では **無効** です。アクティブにデバッグしている間のみ有効にしてください。
- このファイルは機微情報として扱ってください。確認なしに共有しないでください。

## macOS における統合ログのプライベートデータ

統合ログは、サブシステムが `privacy -off` にオプトインしない限り、ほとんどのペイロードをマスクします。Peter による macOS の [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans)（2025）の解説によると、これはサブシステム名をキーとする `/Library/Preferences/Logging/Subsystems/` 内の plist によって制御されます。フラグが反映されるのは新しいログエントリのみのため、問題を再現する前に有効化してください。

## OpenClaw 向けに有効化（`bot.molt`）

- まず plist を一時ファイルとして書き込み、その後 root としてアトミックにインストールします：

```bash
cat <<'EOF' >/tmp/bot.molt.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>DEFAULT-OPTIONS</key>
    <dict>
        <key>Enable-Private-Data</key>
        <true/>
    </dict>
</dict>
</plist>
EOF
sudo install -m 644 -o root -g wheel /tmp/bot.molt.plist /Library/Preferences/Logging/Subsystems/bot.molt.plist
```

- 再起動は不要です。logd は速やかにファイルを認識しますが、プライベートペイロードが含まれるのは新しいログ行のみです。
- 既存のヘルパーを使用して、より詳細な出力を確認できます。例：`./scripts/clawlog.sh --category WebChat --last 5m`。

## デバッグ後に無効化

- オーバーライドを削除します：`sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`。
- 必要に応じて、`sudo log config --reload` を実行し、logd にオーバーライドを直ちに破棄させます。
- このサーフェスには電話番号やメッセージ本文が含まれる可能性があります。追加の詳細が必要な間だけ、plist を配置してください。
