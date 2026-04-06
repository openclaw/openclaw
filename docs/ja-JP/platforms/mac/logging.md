---
read_when:
    - macOSログのキャプチャやプライベートデータのログ記録の調査
    - 音声ウェイク/セッションライフサイクルの問題のデバッグ
summary: 'OpenClawのログ記録: ローリング診断ファイルログ + 統合ログのプライバシーフラグ'
title: macOSログ記録
x-i18n:
    generated_at: "2026-04-02T07:48:01Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: c08d6bc012f8e8bb53353fe654713dede676b4e6127e49fd76e00c2510b9ab0b
    source_path: platforms/mac/logging.md
    workflow: 15
---

# ログ記録（macOS）

## ローリング診断ファイルログ（Debugペイン）

OpenClawはmacOSアプリのログをswift-log（デフォルトで統合ログ）経由でルーティングし、永続的なキャプチャが必要な場合にローカルのローテーションファイルログをディスクに書き込むことができます。

- 詳細度: **Debugペイン → Logs → App logging → Verbosity**
- 有効化: **Debugペイン → Logs → App logging → 「Write rolling diagnostics log (JSONL)」**
- 保存場所: `~/Library/Logs/OpenClaw/diagnostics.jsonl`（自動的にローテーションされ、古いファイルには `.1`、`.2`、… のサフィックスが付きます）
- クリア: **Debugペイン → Logs → App logging → 「Clear」**

注意事項:

- **デフォルトではオフ**です。アクティブにデバッグしている間のみ有効にしてください。
- ファイルには機密情報が含まれる可能性があります。確認せずに共有しないでください。

## macOSの統合ログにおけるプライベートデータ

統合ログは、サブシステムが `privacy -off` にオプトインしない限り、ほとんどのペイロードを墨消しします。Peterが書いたmacOSの[ログプライバシーの問題](https://steipete.me/posts/2025/logging-privacy-shenanigans)（2025年）によると、これは `/Library/Preferences/Logging/Subsystems/` にあるサブシステム名をキーとしたplistで制御されます。新しいログエントリのみがフラグを反映するため、問題を再現する前に有効にしてください。

## OpenClaw（`ai.openclaw`）での有効化

- まずplistを一時ファイルに書き込み、次にrootとしてアトミックにインストールします:

```bash
cat <<'EOF' >/tmp/ai.openclaw.plist
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
sudo install -m 644 -o root -g wheel /tmp/ai.openclaw.plist /Library/Preferences/Logging/Subsystems/ai.openclaw.plist
```

- 再起動は不要です。logdはすぐにファイルを検知しますが、プライベートペイロードが含まれるのは新しいログ行のみです。
- 既存のヘルパーでより詳細な出力を確認できます。例: `./scripts/clawlog.sh --category WebChat --last 5m`。

## デバッグ後の無効化

- オーバーライドを削除します: `sudo rm /Library/Preferences/Logging/Subsystems/ai.openclaw.plist`。
- オプションで `sudo log config --reload` を実行して、logdにオーバーライドを即座に破棄させます。
- このサーフェスには電話番号やメッセージ本文が含まれる可能性があることに注意してください。追加の詳細が実際に必要な間のみplistを配置しておいてください。
