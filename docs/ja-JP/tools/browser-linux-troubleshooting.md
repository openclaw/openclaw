---
read_when: Browser control fails on Linux, especially with snap Chromium
summary: LinuxでのOpenClawブラウザ制御におけるChrome/Brave/Edge/ChromiumのCDP起動問題を修正する
title: ブラウザのトラブルシューティング
x-i18n:
    generated_at: "2026-04-02T08:39:34Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 622fa16d75097bafdede6773f9d1fd546ccc87ea340d06384ed77ed205164231
    source_path: tools/browser-linux-troubleshooting.md
    workflow: 15
---

# ブラウザのトラブルシューティング（Linux）

## 問題：「Failed to start Chrome CDP on port 18800」

OpenClawのブラウザ制御サーバーがChrome/Brave/Edge/Chromiumの起動に失敗し、以下のエラーが表示されます：

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### 根本原因

Ubuntu（および多くのLinuxディストリビューション）では、デフォルトのChromiumインストールは**snapパッケージ**です。snapのAppArmorによる制限が、OpenClawがブラウザプロセスを起動・監視する方法と干渉します。

`apt install chromium` コマンドはsnapにリダイレクトするスタブパッケージをインストールします：

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

これは本物のブラウザではなく、単なるラッパーです。

### 解決策1：Google Chromeをインストールする（推奨）

snapでサンドボックス化されていない公式のGoogle Chrome `.deb` パッケージをインストールします：

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # 依存関係エラーがある場合
```

次に、OpenClawの設定（`~/.openclaw/openclaw.json`）を更新します：

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

### 解決策2：snap Chromiumをアタッチ専用モードで使用する

snap Chromiumを使用する必要がある場合、手動で起動したブラウザにアタッチするようOpenClawを設定します：

1. 設定を更新：

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

2. Chromiumを手動で起動：

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. オプションでsystemdユーザーサービスを作成してChromeを自動起動：

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

有効化：`systemctl --user enable --now openclaw-browser.service`

### ブラウザの動作確認

ステータスを確認：

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

ブラウジングをテスト：

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### 設定リファレンス

| オプション               | 説明                                                                 | デフォルト                                                  |
| ------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| `browser.enabled`        | ブラウザ制御を有効にする                                             | `true`                                                      |
| `browser.executablePath` | Chromiumベースのブラウザバイナリへのパス（Chrome/Brave/Edge/Chromium）| 自動検出（Chromiumベースの場合はデフォルトブラウザを優先）   |
| `browser.headless`       | GUIなしで実行する                                                    | `false`                                                     |
| `browser.noSandbox`      | `--no-sandbox` フラグを追加する（一部のLinux環境で必要）             | `false`                                                     |
| `browser.attachOnly`     | ブラウザを起動せず、既存のブラウザにアタッチのみ行う                 | `false`                                                     |
| `browser.cdpPort`        | Chrome DevTools Protocolポート                                       | `18800`                                                     |

### 問題：「No Chrome tabs found for profile="user"」

`existing-session` / Chrome MCPプロファイルを使用しています。OpenClawはローカルのChromeを検出できますが、アタッチ可能なタブが開かれていません。

修正方法：

1. **管理対象ブラウザを使用する：** `openclaw browser start --browser-profile openclaw`（または `browser.defaultProfile: "openclaw"` を設定）。
2. **Chrome MCPを使用する：** ローカルのChromeが少なくとも1つのタブを開いた状態で実行されていることを確認し、`--browser-profile user` で再試行してください。

注意事項：

- `user` はホスト専用です。Linuxサーバー、コンテナ、またはリモートホストの場合は、CDPプロファイルを使用してください。
- ローカルの `openclaw` プロファイルは `cdpPort`/`cdpUrl` を自動的に割り当てます。リモートCDPの場合のみこれらを設定してください。
