---
summary: "OpenClaw を完全にアンインストールします（CLI、サービス、状態、ワークスペース）"
read_when:
  - マシンから OpenClaw を削除したい場合
  - アンインストール後も ゲートウェイ サービスが実行され続けている場合
title: "アンインストール"
---

# アンインストール

2つのパス:

- **簡単な方法**：`openclaw` がまだインストールされている場合。
- **手動でのサービス削除**：CLI が削除されているが、サービスがまだ実行中の場合。

## 簡単な方法（CLI がまだインストールされている）

推奨：内蔵アンインストーラーを使用します。

```bash
openclaw uninstall
```

非対話型（自動化 / npx）：

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

手動手順（結果は同じです）：

1. ゲートウェイ サービスを停止します。

```bash
openclaw gateway stop
```

2. ゲートウェイ サービスをアンインストールします（launchd / systemd / schtasks）。

```bash
openclaw gateway uninstall
```

3. 状態 + 設定を削除します。

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

`OPENCLAW_CONFIG_PATH` を状態ディレクトリ外のカスタム場所に設定している場合は、そのファイルも削除してください。

4. ワークスペースを削除します（任意、エージェント ファイルが削除されます）。

```bash
rm -rf ~/.openclaw/workspace
```

5. CLI のインストールを削除します（使用した方法を選択してください）。

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. macOS アプリをインストールしていた場合：

```bash
rm -rf /Applications/OpenClaw.app
```

注記：

- プロファイル（`--profile` / `OPENCLAW_PROFILE`）を使用していた場合は、各状態ディレクトリごとに手順 3 を繰り返してください（既定値は `~/.openclaw-<profile>` です）。
- リモートモードでは、state dir は **gateway host** に住んでいるので、ステップ1-4 も実行してください。

## 手動でのサービス削除（CLI がインストールされていない）

ゲートウェイ サービスが実行され続けているが、`openclaw` が見つからない場合に使用します。

### macOS（launchd）

既定のラベルは `bot.molt.gateway`（または `bot.molt.<profile>`。レガシーの `com.openclaw.*` が残っている場合があります）です。

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

プロファイルを使用していた場合は、ラベルと plist 名を `bot.molt.<profile>`. `に置き換えてください。存在する場合は、レガシーの`com.openclaw.\*\` plist を削除してください。

### Linux（systemd ユーザー ユニット）

既定のユニット名は `openclaw-gateway.service`（または `openclaw-gateway-<profile>.service`）です。

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows（スケジュール タスク）

既定のタスク名は `OpenClaw Gateway`（または `OpenClaw Gateway (<profile>)`）です。  
タスク スクリプトは状態ディレクトリ配下にあります。
タスクスクリプトは状態dirの下に保存されます。

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

プロファイルを使用していた場合は、該当するタスク名と `~\.openclaw-<profile>\gateway.cmd` を削除してください。

## 通常インストールとソース チェックアウトの違い

### 通常インストール（install.sh / npm / pnpm / bun）

`https://openclaw.ai/install.sh` または `install.ps1` を使用した場合、CLI は `npm install -g openclaw@latest` でインストールされています。  
`npm rm -g openclaw` で削除してください（その方法でインストールした場合は `pnpm remove -g` / `bun remove -g` を使用します）。
`npm rm -g openclaw` で削除します。または、`pnpm remove -g` / `bun remove -g` をインストールします。

### ソース チェックアウト（git clone）

リポジトリのチェックアウトから実行している場合（`git clone` + `openclaw ...` / `bun run openclaw ...`）：

1. リポジトリを削除する **前に** ゲートウェイ サービスをアンインストールします（上記の簡単な方法、または手動でのサービス削除を使用してください）。
2. リポジトリ ディレクトリを削除します。
3. 上記の手順に従って、状態 + ワークスペースを削除します。
