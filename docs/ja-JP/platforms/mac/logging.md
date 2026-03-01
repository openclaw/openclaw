---
summary: "OpenClawロギング：ローリング診断ファイルログ + 統合ログのプライバシーフラグ"
read_when:
  - macOSログのキャプチャやプライベートデータロギングの調査
  - Voice Wake/セッションライフサイクルの問題のデバッグ
title: "macOSロギング"
---

# ロギング（macOS）

## ローリング診断ファイルログ（Debugペイン）

OpenClawはmacOSアプリのログをswift-log（デフォルトで統合ロギング）を通してルーティングし、永続的なキャプチャが必要な場合にローカルのローテーションファイルログをディスクに書き込むことができます。

- 詳細度：**Debugペイン → Logs → App logging → Verbosity**
- 有効化：**Debugペイン → Logs → App logging → 「Write rolling diagnostics log (JSONL)」**
- 保存場所：`~/Library/Logs/OpenClaw/diagnostics.jsonl`（自動ローテーション。古いファイルには`.1`、`.2`などのサフィックスが付きます）
- クリア：**Debugペイン → Logs → App logging → 「Clear」**

注意事項：

- これは**デフォルトでオフ**です。アクティブなデバッグ中にのみ有効化してください。
- ファイルには機密情報が含まれる可能性があります。レビューなしで共有しないでください。

## macOSの統合ロギングにおけるプライベートデータ

統合ロギングは、サブシステムが`privacy -off`を選択しない限り、ほとんどのペイロードを秘匿化します。macOSの[ロギングプライバシーの注意点](https://steipete.me/posts/2025/logging-privacy-shenanigans)（2025年）に関するPeterの解説によると、これはサブシステム名をキーとする`/Library/Preferences/Logging/Subsystems/`内のplistで制御されます。新しいログエントリのみがこのフラグを反映するため、問題を再現する前に有効化してください。

## OpenClaw（`ai.openclaw`）での有効化

- まずplistを一時ファイルに書き込み、rootとしてアトミックにインストールします：

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

- 再起動は不要です。logdはすぐにファイルを検出しますが、プライベートペイロードを含むのは新しいログ行のみです。
- 既存のヘルパーを使用してリッチな出力を確認できます。例：`./scripts/clawlog.sh --category WebChat --last 5m`。

## デバッグ後の無効化

- オーバーライドを削除します：`sudo rm /Library/Preferences/Logging/Subsystems/ai.openclaw.plist`。
- 必要に応じて`sudo log config --reload`を実行し、logdにオーバーライドを即座に破棄させます。
- このサーフェスには電話番号やメッセージ本文が含まれる可能性があることを忘れないでください。追加の詳細が必要な間だけplistを保持してください。
