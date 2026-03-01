---
summary: "Linux上でのOpenClawブラウザコントロール向けChrome/Brave/Edge/Chromium CDPの起動問題を修正する"
read_when: "特にsnapのChromiumでLinux上のブラウザコントロールが失敗する場合"
title: "ブラウザトラブルシューティング"
---

# ブラウザトラブルシューティング（Linux）

## 問題:「Failed to start Chrome CDP on port 18800」

OpenClawのブラウザコントロールサーバーが以下のエラーでChrome/Brave/Edge/Chromiumの起動に失敗します:

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### 根本原因

Ubuntu（および多くのLinuxディストリビューション）では、デフォルトのChromiumインストールは **snapパッケージ** です。SnapのAppArmorによる制限が、OpenClawがブラウザプロセスを起動・監視する方法に干渉します。

`apt install chromium` コマンドはsnapにリダイレクトするスタブパッケージをインストールします:

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

これは本物のブラウザではなく、ただのラッパーです。

### 解決策1: Google Chromeをインストールする（推奨）

snapでサンドボックス化されていない公式のGoogle Chrome `.deb` パッケージをインストールします:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # 依存関係エラーがある場合
```

次に、OpenClawの設定（`~/.openclaw/openclaw.json`）を更新します:

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

### 解決策2: snap ChromiumをAttach-Onlyモードで使用する

snap Chromiumを使用する必要がある場合は、OpenClawを手動で起動したブラウザにアタッチするよう設定します:

1. 設定を更新します:

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

2. Chromiumを手動で起動します:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. オプションとして、Chromeを自動起動するsystemdユーザーサービスを作成します:

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

有効化: `systemctl --user enable --now openclaw-browser.service`

### ブラウザの動作確認

ステータスを確認します:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

ブラウジングをテストします:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### 設定リファレンス

| オプション               | 説明                                                                   | デフォルト                                                    |
| ------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| `browser.enabled`        | ブラウザコントロールを有効にする                                       | `true`                                                        |
| `browser.executablePath` | Chromiumベースのブラウザバイナリへのパス（Chrome/Brave/Edge/Chromium） | 自動検出（Chromiumベースの場合はデフォルトブラウザを優先）    |
| `browser.headless`       | GUIなしで実行する                                                      | `false`                                                       |
| `browser.noSandbox`      | `--no-sandbox` フラグを追加する（一部のLinux環境で必要）               | `false`                                                       |
| `browser.attachOnly`     | ブラウザを起動せず、既存のブラウザにのみアタッチする                   | `false`                                                       |
| `browser.cdpPort`        | Chrome DevTools Protocolポート                                         | `18800`                                                       |

### 問題:「Chrome extension relay is running, but no tab is connected」

`chrome` プロファイル（エクステンションリレー）を使用しています。これはOpenClawブラウザエクステンションがライブタブにアタッチされていることを期待しています。

修正オプション:

1. **マネージドブラウザを使用する:** `openclaw browser start --browser-profile openclaw`
   （または `browser.defaultProfile: "openclaw"` を設定する）。
2. **エクステンションリレーを使用する:** エクステンションをインストールし、タブを開いて、
   OpenClawエクステンションアイコンをクリックしてアタッチします。

注意事項:

- `chrome` プロファイルは可能な場合、**システムデフォルトのChromiumブラウザ**を使用します。
- ローカルの `openclaw` プロファイルは `cdpPort`/`cdpUrl` を自動割り当てします。リモートCDP用にのみそれらを設定してください。
