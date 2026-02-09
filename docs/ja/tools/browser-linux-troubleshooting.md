---
summary: "Linux 上で OpenClaw のブラウザー制御を使用する際の Chrome/Brave/Edge/Chromium CDP 起動問題を修正します"
read_when: "特に snap 版 Chromium を使用している場合に、Linux 上でブラウザー制御が失敗するとき"
title: "ブラウザーのトラブルシューティング"
---

# ブラウザーのトラブルシューティング（Linux）

## 問題: 「Failed to start Chrome CDP on port 18800」

OpenClaw のブラウザー制御サーバーが、次のエラーとともに Chrome/Brave/Edge/Chromium の起動に失敗します。

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### 原因

Ubuntu（および多くの Linux ディストリビューション）では、既定の Chromium インストールは **snap パッケージ** です。Snap の AppArmor による制限が、OpenClaw によるブラウザープロセスの起動および監視の方法と干渉します。 SnapのAppArmorの監禁は、OpenClawがブラウザプロセスをどのように生成し監視するかを妨げます。

`apt install chromium` コマンドは、snap にリダイレクトするスタブパッケージをインストールします。

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

これは実際のブラウザーではありません。単なるラッパーです。

### 解決策 1: Google Chrome をインストールする（推奨）

snap によるサンドボックス化がされていない、公式の Google Chrome `.deb` パッケージをインストールします。

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

次に、OpenClaw の設定（`~/.openclaw/openclaw.json`）を更新します。

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/google-chrome-stable",
    "headless": true,
    "noSandbox": true
  }
}
```

### 解決策 2: Snap 版 Chromium をアタッチ専用モードで使用する

snap 版 Chromium を使用する必要がある場合は、手動で起動したブラウザーにアタッチするよう OpenClaw を設定します。

1. 設定を更新します。

```json
{
  "browser": {
    "enabled": true,
    "attachOnly": true,
    "headless": true,
    "noSandbox": true
  }
}
```

2. Chromium を手動で起動します。

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. 必要に応じて、Chrome を自動起動する systemd ユーザーサービスを作成します。

```ini
# ~/.config/systemd/user/openclaw-browser.service
[Unit]
Description=OpenClaw Browser (Chrome CDP)
After=network.target

[Service]
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.openclaw/browser/openclaw/user-data about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

次のコマンドで有効化します: `systemctl --user enable --now openclaw-browser.service`

### ブラウザーが動作していることを確認する

ステータスを確認します。

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

ブラウジングをテストします。

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### 設定リファレンス

| オプション                    | 説明                                                 | デフォルト                           |
| ------------------------ | -------------------------------------------------- | ------------------------------- |
| `browser.enabled`        | ブラウザー制御を有効化                                        | `true`                          |
| `browser.executablePath` | Chromium 系ブラウザー（Chrome/Brave/Edge/Chromium）のバイナリパス | 自動検出（Chromium 系の場合は既定のブラウザーを優先） |
| `browser.headless`       | GUI なしで実行                                          | `false`                         |
| `browser.noSandbox`      | `--no-sandbox` フラグを追加（Linux の一部構成で必要）              | `false`                         |
| `browser.attachOnly`     | ブラウザーを起動せず、既存のものにのみアタッチ                            | `false`                         |
| `browser.cdpPort`        | Chrome DevTools Protocol のポート                      | `18800`                         |

### 問題: 「Chrome extension relay is running, but no tab is connected」

`chrome` プロファイル（拡張機能リレー）を使用しています。これは、OpenClaw のブラウザー拡張機能がアクティブなタブに接続されていることを前提としています。 OpenClaw
ブラウザ拡張機能がライブタブに追加されることを期待します。

修正方法:

1. **マネージドブラウザーを使用する:** `openclaw browser start --browser-profile openclaw`
   （または `browser.defaultProfile: "openclaw"` を設定します）。
2. **拡張機能リレーを使用する:** 拡張機能をインストールし、タブを開いてから OpenClaw 拡張機能アイコンをクリックして接続します。

注記:

- `chrome` プロファイルは、可能な場合に **システム既定の Chromium ブラウザー** を使用します。
- ローカルの `openclaw` プロファイルでは `cdpPort`/`cdpUrl` が自動的に割り当てられます。これらはリモート CDP の場合のみ設定してください。
