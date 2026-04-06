---
read_when:
    - WindowsにOpenClawをインストールする場合
    - ネイティブWindowsとWSL2のどちらを選ぶか検討する場合
    - Windowsコンパニオンアプリの状況を確認する場合
summary: 'Windowsサポート: ネイティブおよびWSL2のインストールパス、デーモン、および現在の注意事項'
title: Windows
x-i18n:
    generated_at: "2026-04-02T08:35:19Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: e1d4dcc1f535ad8901b1eee15b40250865a35762610906a6985d38a30e0bc8e4
    source_path: platforms/windows.md
    workflow: 15
---

# Windows

OpenClawは**ネイティブWindows**と**WSL2**の両方をサポートしています。WSL2の方が安定しており、フルエクスペリエンスにはWSL2を推奨します — CLI、Gateway ゲートウェイ、およびツール類は完全な互換性を持つLinux内で動作します。ネイティブWindowsはコアCLIおよび Gateway ゲートウェイの使用に対応していますが、以下にいくつかの注意事項があります。

ネイティブWindowsのコンパニオンアプリは計画中です。

## WSL2（推奨）

- [はじめに](/start/getting-started)（WSL内で使用）
- [インストールと更新](/install/updating)
- 公式WSL2ガイド（Microsoft）: [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## ネイティブWindowsの状況

ネイティブWindows CLIフローは改善が進んでいますが、WSL2が依然として推奨パスです。

現在ネイティブWindowsで正常に動作するもの:

- `install.ps1` 経由のWebサイトインストーラー
- `openclaw --version`、`openclaw doctor`、`openclaw plugins list --json` などのローカルCLI使用
- 以下のような組み込みローカルエージェント/プロバイダーのスモークテスト:

```powershell
openclaw agent --local --agent main --thinking low -m "Reply with exactly WINDOWS-HATCH-OK."
```

現在の注意事項:

- `openclaw onboard --non-interactive` は、`--skip-health` を渡さない限り、到達可能なローカル Gateway ゲートウェイを必要とする
- `openclaw onboard --non-interactive --install-daemon` と `openclaw gateway install` は最初にWindowsスケジュールタスクを試みる
- スケジュールタスクの作成が拒否された場合、OpenClawはユーザーごとのスタートアップフォルダーのログイン項目にフォールバックし、Gateway ゲートウェイを即座に起動する
- `schtasks` 自体がハングまたは応答停止した場合、OpenClawはそのパスを素早く中断し、永久にハングする代わりにフォールバックする
- スケジュールタスクは、より優れたスーパーバイザーステータスを提供するため、利用可能な場合は依然として推奨される

Gateway ゲートウェイサービスのインストールなしでネイティブCLIのみを使用したい場合は、以下のいずれかを使用してください:

```powershell
openclaw onboard --non-interactive --skip-health
openclaw gateway run
```

ネイティブWindowsでマネージドスタートアップを使用したい場合:

```powershell
openclaw gateway install
openclaw gateway status --json
```

スケジュールタスクの作成がブロックされた場合、フォールバックサービスモードは現在のユーザーのスタートアップフォルダーを通じてログイン後に自動起動します。

## Gateway ゲートウェイ

- [Gateway ゲートウェイ運用ガイド](/gateway)
- [設定](/gateway/configuration)

## Gateway ゲートウェイサービスのインストール（CLI）

WSL2内:

```
openclaw onboard --install-daemon
```

または:

```
openclaw gateway install
```

または:

```
openclaw configure
```

プロンプトが表示されたら **Gateway service** を選択します。

修復/移行:

```
openclaw doctor
```

## Windowsログイン前の Gateway ゲートウェイ自動起動

ヘッドレスセットアップの場合、誰もWindowsにログインしていなくても完全なブートチェーンが実行されるようにします。

### 1) ログインなしでユーザーサービスを実行し続ける

WSL内:

```bash
sudo loginctl enable-linger "$(whoami)"
```

### 2) OpenClaw Gateway ゲートウェイユーザーサービスをインストールする

WSL内:

```bash
openclaw gateway install
```

### 3) Windowsブート時にWSLを自動起動する

管理者としてPowerShellで:

```powershell
schtasks /create /tn "WSL Boot" /tr "wsl.exe -d Ubuntu --exec /bin/true" /sc onstart /ru SYSTEM
```

`Ubuntu` は以下で確認できるディストリビューション名に置き換えてください:

```powershell
wsl --list --verbose
```

### スタートアップチェーンの確認

再起動後（Windowsサインイン前）、WSLから確認します:

```bash
systemctl --user is-enabled openclaw-gateway
systemctl --user status openclaw-gateway --no-pager
```

## 応用: WSLサービスをLAN経由で公開する（portproxy）

WSLは独自の仮想ネットワークを持っています。別のマシンから**WSL内**で実行中のサービス（SSH、ローカルTTSサーバー、または Gateway ゲートウェイ）にアクセスする必要がある場合、WindowsポートをWSLの現在のIPにフォワードする必要があります。WSL IPは再起動後に変わるため、フォワーディングルールの更新が必要になる場合があります。

例（**管理者として**PowerShell）:

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Windowsファイアウォールでポートを許可します（初回のみ）:

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

WSL再起動後にportproxyを更新します:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

注意事項:

- 別のマシンからのSSHは**WindowsホストIP**をターゲットにします（例: `ssh user@windows-host -p 2222`）。
- リモートノードは**到達可能な** Gateway ゲートウェイURL（`127.0.0.1` ではない）を指す必要があります。`openclaw status --all` で確認してください。
- LANアクセスには `listenaddress=0.0.0.0` を使用します。`127.0.0.1` はローカルのみに制限されます。
- これを自動化したい場合は、ログイン時に更新ステップを実行するスケジュールタスクを登録してください。

## WSL2のステップバイステップインストール

### 1) WSL2 + Ubuntuのインストール

PowerShell（管理者）を開きます:

```powershell
wsl --install
# またはディストリビューションを明示的に選択:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Windowsが要求した場合は再起動します。

### 2) systemdを有効にする（Gateway ゲートウェイのインストールに必須）

WSLターミナルで:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

次にPowerShellから:

```powershell
wsl --shutdown
```

Ubuntuを再度開き、確認します:

```bash
systemctl --user status
```

### 3) OpenClawのインストール（WSL内）

WSL内でLinuxのはじめにフローに従います:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # 初回実行時にUI依存関係を自動インストール
pnpm build
openclaw onboard
```

完全ガイド: [はじめに](/start/getting-started)

## Windowsコンパニオンアプリ

Windowsコンパニオンアプリはまだありません。実現に向けたコントリビューションを歓迎します。
