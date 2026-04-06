---
read_when:
    - マシンからOpenClawを完全に削除したい場合
    - アンインストール後もGateway ゲートウェイサービスが実行され続けている場合
summary: OpenClawを完全にアンインストールする（CLI、サービス、状態、ワークスペース）
title: アンインストール
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 34c7d3e4ad17333439048dfda739fc27db47e7f9e4212fe17db0e4eb3d3ab258
    source_path: install/uninstall.md
    workflow: 15
---

# アンインストール

2つの方法：

- **簡単な方法**: `openclaw`がまだインストールされている場合。
- **手動サービス削除**: CLIが消えているがサービスがまだ実行されている場合。

## 簡単な方法（CLIがまだインストールされている場合）

組み込みのアンインストーラーを使用することを推奨：

```bash
openclaw uninstall
```

非対話型（自動化 / npx）：

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

手動手順（同じ結果）：

1. Gateway ゲートウェイサービスを停止：

```bash
openclaw gateway stop
```

2. Gateway ゲートウェイサービスをアンインストール（launchd/systemd/schtasks）：

```bash
openclaw gateway uninstall
```

3. 状態と設定を削除：

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

`OPENCLAW_CONFIG_PATH`を状態ディレクトリ外のカスタムの場所に設定した場合は、そのファイルも削除してください。

4. ワークスペースを削除（オプション、エージェントファイルを削除）：

```bash
rm -rf ~/.openclaw/workspace
```

5. CLIのインストールを削除（使用したものを選択）：

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

- プロファイル（`--profile` / `OPENCLAW_PROFILE`）を使用した場合は、各状態ディレクトリ（デフォルトは`~/.openclaw-<profile>`）についてステップ3を繰り返してください。
- リモートモードでは、状態ディレクトリは**Gateway ゲートウェイホスト**上にあるため、そこでもステップ1〜4を実行してください。

## 手動サービス削除（CLIがインストールされていない場合）

Gateway ゲートウェイサービスが実行され続けているが`openclaw`が見つからない場合に使用してください。

### macOS（launchd）

デフォルトのラベルは`ai.openclaw.gateway`（または`ai.openclaw.<profile>`; レガシーの`com.openclaw.*`がまだ存在する場合があります）：

```bash
launchctl bootout gui/$UID/ai.openclaw.gateway
rm -f ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

プロファイルを使用した場合は、ラベルとplist名を`ai.openclaw.<profile>`に置き換えてください。レガシーの`com.openclaw.*` plistsがある場合は削除してください。

### Linux（systemdユーザーユニット）

デフォルトのユニット名は`openclaw-gateway.service`（または`openclaw-gateway-<profile>.service`）：

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows（スケジュールタスク）

デフォルトのタスク名は`OpenClaw Gateway`（または`OpenClaw Gateway (<profile>)`）。
タスクスクリプトは状態ディレクトリ以下にあります。

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

プロファイルを使用した場合は、対応するタスク名と`~\.openclaw-<profile>\gateway.cmd`を削除してください。

## 通常のインストールとソースチェックアウト

### 通常のインストール（install.sh / npm / pnpm / bun）

`https://openclaw.ai/install.sh`または`install.ps1`を使用した場合、CLIは`npm install -g openclaw@latest`でインストールされています。
`npm rm -g openclaw`で削除してください（その方法でインストールした場合は`pnpm remove -g` / `bun remove -g`）。

### ソースチェックアウト（git clone）

リポジトリチェックアウト（`git clone` + `openclaw ...` / `bun run openclaw ...`）から実行している場合：

1. リポジトリを削除する**前に**Gateway ゲートウェイサービスをアンインストールしてください（上の簡単な方法または手動サービス削除を使用）。
2. リポジトリディレクトリを削除。
3. 上記の通り状態とワークスペースを削除。
