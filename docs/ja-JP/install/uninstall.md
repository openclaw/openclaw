---
summary: "OpenClawの完全アンインストール（CLI、サービス、状態、ワークスペース）"
read_when:
  - You want to remove OpenClaw from a machine
  - The gateway service is still running after uninstall
title: "アンインストール"
---

# アンインストール

2つの方法があります:

- `openclaw`がまだインストールされている場合の**簡単な方法**。
- CLIは削除済みだがサービスがまだ動いている場合の**手動サービス削除**。

## 簡単な方法（CLIがインストール済み）

推奨: 組み込みのアンインストーラーを使用:

```bash
openclaw uninstall
```

非対話モード（自動化 / npx）:

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

手動手順（同じ結果）:

1. Gatewayサービスを停止:

```bash
openclaw gateway stop
```

2. Gatewayサービスをアンインストール（launchd/systemd/schtasks）:

```bash
openclaw gateway uninstall
```

3. 状態ファイルと設定を削除:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

`OPENCLAW_CONFIG_PATH`を状態ディレクトリ外のカスタムパスに設定している場合は、そのファイルも削除してください。

4. ワークスペースを削除（任意、エージェントファイルが削除されます）:

```bash
rm -rf ~/.openclaw/workspace
```

5. CLIを削除（使用したものを選択）:

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. macOSアプリをインストールした場合:

```bash
rm -rf /Applications/OpenClaw.app
```

補足:

- プロファイル（`--profile` / `OPENCLAW_PROFILE`）を使用した場合、手順3を各状態ディレクトリ（デフォルトは`~/.openclaw-<profile>`）に対して繰り返してください。
- リモートモードの場合、状態ディレクトリは**Gatewayホスト**にあるため、そちらでも手順1-4を実行してください。

## 手動サービス削除（CLIが未インストール）

Gatewayサービスが動き続けているが`openclaw`がない場合、こちらを使用してください。

### macOS (launchd)

デフォルトのラベルは`bot.molt.gateway`（またはプロファイル使用時は`bot.molt.<profile>`、レガシーの`com.openclaw.*`が残っている場合もあります）:

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

プロファイルを使用した場合、ラベルとplistファイル名を`bot.molt.<profile>`に置き換えてください。レガシーの`com.openclaw.*` plistが存在する場合は削除してください。

### Linux (systemd ユーザーユニット)

デフォルトのユニット名は`openclaw-gateway.service`（またはプロファイル使用時は`openclaw-gateway-<profile>.service`）:

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (スケジュールタスク)

デフォルトのタスク名は`OpenClaw Gateway`（またはプロファイル使用時は`OpenClaw Gateway (<profile>)`）。
タスクスクリプトは状態ディレクトリにあります。

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

プロファイルを使用した場合、対応するタスク名と`~\.openclaw-<profile>\gateway.cmd`を削除してください。
