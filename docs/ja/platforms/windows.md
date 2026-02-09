---
summary: "Windows（WSL2）サポートおよびコンパニオンアプリの状況"
read_when:
  - Windows への OpenClaw のインストール時
  - Windows コンパニオンアプリの状況を探している場合
title: "Windows（WSL2）"
---

# Windows（WSL2）

Windows 上の OpenClaw は、**WSL2 経由**（Ubuntu 推奨）での利用を推奨します。  
CLI と Gateway（ゲートウェイ）は Linux 内で実行されるため、ランタイムの一貫性が保たれ、ツール群との互換性（Node / Bun / pnpm、Linux バイナリ、Skills）が大幅に向上します。  
ネイティブの Windows 環境はやや扱いが難しい場合があります。WSL2 では完全な Linux 体験を提供し、インストールは 1 コマンドで完了します：`wsl --install`。
CLI + Gatewayは、Linux内で実行され、ランタイムの一貫性を保ち、
ツールははるかに互換性があります (Node/Bun/pnpm、Linuxバイナリ、スキル)。 ネイティブ
Windowsはトリッキーかもしれません。 WSL2はLinuxをフル活用します。1つのコマンド
でインストール: `wsl --install` です。

ネイティブの Windows コンパニオンアプリは計画中です。

## インストール（WSL2）

- [Getting Started](/start/getting-started)（WSL 内で使用してください）
- [Install & updates](/install/updating)
- 公式 WSL2 ガイド（Microsoft）：[https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Gateway runbook](/gateway)
- [Configuration](/gateway/configuration)

## Gateway サービスのインストール（CLI）

WSL2 内で実行します：

```
openclaw onboard --install-daemon
```

または：

```
openclaw gateway install
```

または：

```
openclaw configure
```

プロンプトが表示されたら **Gateway service** を選択してください。

修復／移行：

```
openclaw doctor
```

## 上級者向け：WSL サービスを LAN に公開する（portproxy）

WSLには独自の仮想ネットワークがあります。 WSL には独自の仮想ネットワークがあります。別のマシンから **WSL 内で実行中** のサービス（SSH、ローカル TTS サーバー、または Gateway）にアクセスする必要がある場合、Windows のポートを現在の WSL IP に転送する必要があります。WSL の IP は再起動後に変更されるため、転送ルールの更新が必要になる場合があります。 1. WSL の IP は再起動後に変わるため、
転送ルールを更新する必要がある場合があります。

例（PowerShell **管理者として実行**）：

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Windows ファイアウォールでポートを許可します（初回のみ）：

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

WSL の再起動後に portproxy を更新します：

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

注記：

- 別のマシンからの SSH 接続は **Windows ホストの IP** を指定します（例：`ssh user@windows-host -p 2222`）。
- リモートノードは **到達可能な** Gateway URL（`127.0.0.1` ではありません）を指定する必要があります。確認には `openclaw status --all` を使用してください。
- LAN アクセスには `listenaddress=0.0.0.0` を使用します。`127.0.0.1` はローカルのみに制限します。
- これを自動化したい場合は、ログイン時に更新手順を実行するスケジュールされたタスクを登録してください。

## WSL2 のステップバイステップ インストール

### 1. WSL2 + Ubuntu のインストール

PowerShell を開きます（管理者）：

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Windows から再起動を求められた場合は、再起動してください。

### 2. systemd を有効化（Gateway のインストールに必須）

WSL ターミナル内で実行します：

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

その後、PowerShell から実行します：

```powershell
wsl --shutdown
```

Ubuntu を再度開き、次を確認してください：

```bash
systemctl --user status
```

### 3. OpenClaw のインストール（WSL 内）

WSL 内で Linux 向けの Getting Started フローに従ってください：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

完全なガイド：[Getting Started](/start/getting-started)

## Windows コンパニオンアプリ

私たちはまだWindowsコンパニオンアプリを持っていません。
コントリビューションを実現させたい場合は、コントリビューションを歓迎します。
