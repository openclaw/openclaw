---
summary: "OpenClaw.app がリモートゲートウェイに接続するための SSH トンネル設定"
read_when: "macOS アプリを SSH 経由でリモートゲートウェイに接続する場合"
title: "リモートゲートウェイのセットアップ"
x-i18n:
  source_path: gateway/remote-gateway-readme.md
  source_hash: b1ae266a7cb4911b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:55Z
---

# リモートゲートウェイで OpenClaw.app を実行する

OpenClaw.app は、SSH トンネルを使用してリモートゲートウェイに接続します。このガイドでは、その設定方法を説明します。

## 概要

```
┌─────────────────────────────────────────────────────────────┐
│                        Client Machine                          │
│                                                              │
│  OpenClaw.app ──► ws://127.0.0.1:18789 (local port)           │
│                     │                                        │
│                     ▼                                        │
│  SSH Tunnel ────────────────────────────────────────────────│
│                     │                                        │
└─────────────────────┼──────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                         Remote Machine                        │
│                                                              │
│  Gateway WebSocket ──► ws://127.0.0.1:18789 ──►              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## クイックスタート

### ステップ 1: SSH 設定を追加

`~/.ssh/config` を編集し、次を追加します。

```ssh
Host remote-gateway
    HostName <REMOTE_IP>          # e.g., 172.27.187.184
    User <REMOTE_USER>            # e.g., jefferson
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

`<REMOTE_IP>` と `<REMOTE_USER>` をご自身の値に置き換えてください。

### ステップ 2: SSH キーをコピー

公開鍵をリモートマシンにコピーします（パスワードは 1 回入力します）。

```bash
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER>@<REMOTE_IP>
```

### ステップ 3: ゲートウェイ トークンを設定

```bash
launchctl setenv OPENCLAW_GATEWAY_TOKEN "<your-token>"
```

### ステップ 4: SSH トンネルを開始

```bash
ssh -N remote-gateway &
```

### ステップ 5: OpenClaw.app を再起動

```bash
# Quit OpenClaw.app (⌘Q), then reopen:
open /path/to/OpenClaw.app
```

これで、アプリは SSH トンネルを介してリモートゲートウェイに接続します。

---

## ログイン時にトンネルを自動起動

ログイン時に SSH トンネルを自動的に起動するには、Launch Agent を作成します。

### PLIST ファイルを作成

次を `~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist` として保存します。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>bot.molt.ssh-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/ssh</string>
        <string>-N</string>
        <string>remote-gateway</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

### Launch Agent を読み込む

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist
```

これにより、トンネルは次のように動作します。

- ログイン時に自動的に起動
- クラッシュした場合に再起動
- バックグラウンドで継続して実行

レガシー注記: 既存の `com.openclaw.ssh-tunnel` LaunchAgent がある場合は削除してください。

---

## トラブルシューティング

**トンネルが実行中か確認する:**

```bash
ps aux | grep "ssh -N remote-gateway" | grep -v grep
lsof -i :18789
```

**トンネルを再起動する:**

```bash
launchctl kickstart -k gui/$UID/bot.molt.ssh-tunnel
```

**トンネルを停止する:**

```bash
launchctl bootout gui/$UID/bot.molt.ssh-tunnel
```

---

## 仕組み

| コンポーネント                       | 役割                                                      |
| ------------------------------------ | --------------------------------------------------------- |
| `LocalForward 18789 127.0.0.1:18789` | ローカルポート 18789 をリモートポート 18789 に転送        |
| `ssh -N`                             | リモートコマンドを実行せずに SSH を使用（ポート転送のみ） |
| `KeepAlive`                          | クラッシュ時にトンネルを自動的に再起動                    |
| `RunAtLoad`                          | エージェントの読み込み時にトンネルを起動                  |

OpenClaw.app は、クライアントマシン上の `ws://127.0.0.1:18789` に接続します。SSH トンネルは、その接続をリモートマシン上で Gateway（ゲートウェイ）が実行されているポート 18789 に転送します。
