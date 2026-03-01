---
summary: "OpenClawの完全なアンインストール（CLI、サービス、状態、ワークスペース）"
read_when:
  - マシンからOpenClawを削除したい場合
  - アンインストール後もGatewayサービスが実行されている場合
title: "アンインストール"
---

# アンインストール

2つの方法があります：

- `openclaw`がまだインストールされている場合の**簡単な方法**。
- CLIが削除されたがサービスがまだ実行されている場合の**手動サービス削除**。

## 簡単な方法（CLIがまだインストール済み）

推奨：組み込みのアンインストーラーを使用してください：

```bash
openclaw uninstall
```

非対話型（自動化 / npx）：

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

手動手順（同じ結果）：

1. Gatewayサービスを停止：

```bash
openclaw gateway stop
```

2. Gatewayサービスをアンインストール（launchd/systemd/schtasks）：

```bash
openclaw gateway uninstall
```

3. 状態 + 設定を削除：

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

`OPENCLAW_CONFIG_PATH`を状態ディレクトリ外のカスタムロケーションに設定している場合は、そのファイルも削除してください。

4. ワークスペースを削除（オプション、エージェントファイルを削除）：

```bash
rm -rf ~/.openclaw/workspace
```

5. CLIインストールを削除（使用したものを選択）：

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. macOSアプリをインストールした場合：

```bash
rm -rf /Applications/OpenClaw.app
```

注意：

- プロファイル（`--profile` / `OPENCLAW_PROFILE`）を使用した場合は、各状態ディレクトリに対してステップ3を繰り返してください（デフォルトは`~/.openclaw-<profile>`）。
- リモートモードでは、状態ディレクトリは**Gatewayホスト**上にあるため、ステップ1-4もそこで実行してください。

## 手動サービス削除（CLIがインストールされていない場合）

Gatewayサービスが実行されているが`openclaw`が見つからない場合に使用してください。

### macOS（launchd）

デフォルトのラベルは`ai.openclaw.gateway`（または`ai.openclaw.<profile>`、レガシーの`com.openclaw.*`がまだ存在する場合もあります）：

```bash
launchctl bootout gui/$UID/ai.openclaw.gateway
rm -f ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

プロファイルを使用した場合は、ラベルとplistファイル名を`ai.openclaw.<profile>`に置き換えてください。レガシーの`com.openclaw.*`のplistが存在する場合は削除してください。

### Linux（systemdユーザーユニット）

デフォルトのユニット名は`openclaw-gateway.service`（または`openclaw-gateway-<profile>.service`）：

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows（スケジュールされたタスク）

デフォルトのタスク名は`OpenClaw Gateway`（または`OpenClaw Gateway (<profile>)`）です。
タスクスクリプトは状態ディレクトリ下にあります。

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

プロファイルを使用した場合は、対応するタスク名と`~\.openclaw-<profile>\gateway.cmd`を削除してください。

## 通常インストール対ソースチェックアウト

### 通常インストール（install.sh / npm / pnpm / bun）

`https://openclaw.ai/install.sh`または`install.ps1`を使用した場合、CLIは`npm install -g openclaw@latest`でインストールされています。
`npm rm -g openclaw`で削除してください（pnpmでインストールした場合は`pnpm remove -g`、bunの場合は`bun remove -g`）。

### ソースチェックアウト（git clone）

リポジトリチェックアウトから実行している場合（`git clone` + `openclaw ...` / `bun run openclaw ...`）：

1. リポジトリを削除する**前に**Gatewayサービスをアンインストールしてください（上記の簡単な方法または手動サービス削除を使用）。
2. リポジトリディレクトリを削除。
3. 上記の通り状態 + ワークスペースを削除。
