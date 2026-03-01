---
summary: "Windows（WSL2）サポート + コンパニオンアプリの状況"
read_when:
  - Windows に OpenClaw をインストールする
  - Windows コンパニオンアプリの状況を調べている
title: "Windows (WSL2)"
---

# Windows (WSL2)

Windows での OpenClaw は **WSL2 経由**での利用が推奨されます（Ubuntu 推奨）。
CLI + Gateway は Linux 内で実行されるため、ランタイムの一貫性が保たれ、ツールの互換性が
大幅に向上します（Node/Bun/pnpm、Linux バイナリ、スキル）。ネイティブ Windows は
難しい場合があります。WSL2 なら完全な Linux 環境が利用できます。インストールは
コマンド一つで完了します：`wsl --install`。

ネイティブ Windows コンパニオンアプリは計画中です。

## インストール（WSL2）

- [はじめに](/start/getting-started)（WSL 内で実行）
- [インストール & 更新](/install/updating)
- 公式 WSL2 ガイド（Microsoft）：[https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Gateway 運用手順書](/gateway)
- [設定](/gateway/configuration)

## Gateway サービスインストール（CLI）

WSL2 内で：

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

修復/移行：

```
openclaw doctor
```

## 上級者向け：WSL サービスを LAN に公開する（portproxy）

WSL には独自の仮想ネットワークがあります。別のマシンが **WSL 内で**実行されている
サービス（SSH、ローカル TTS サーバー、または Gateway）に到達する必要がある場合は、
Windows のポートを現在の WSL IP にフォワーディングする必要があります。WSL IP は再起動後に
変わるため、フォワーディングルールの更新が必要になる場合があります。

例（PowerShell を**管理者として**実行）：

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

WSL 再起動後に portproxy をリフレッシュします：

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

注意：

- 他のマシンからの SSH は **Windows ホスト IP** を対象にします（例：`ssh user@windows-host -p 2222`）。
- リモートノードは**到達可能な** Gateway URL を指す必要があります（`127.0.0.1` ではない）。
  `openclaw status --all` で確認してください。
- LAN アクセスには `listenaddress=0.0.0.0` を使用し、`127.0.0.1` はローカルのみに制限します。
- これを自動化したい場合は、ログイン時にリフレッシュステップを実行するスケジュールタスクを登録してください。

## ステップバイステップ WSL2 インストール

### 1) WSL2 + Ubuntu をインストール

PowerShell（管理者）を開きます：

```powershell
wsl --install
# またはディストリビューションを明示的に指定：
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Windows から求められた場合は再起動してください。

### 2) systemd を有効にする（Gateway インストールに必要）

WSL ターミナルで：

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

次に PowerShell で：

```powershell
wsl --shutdown
```

Ubuntu を再度開き、以下で確認します：

```bash
systemctl --user status
```

### 3) OpenClaw をインストール（WSL 内）

WSL 内で Linux の「はじめに」フローに従います：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # 初回実行時に UI の依存関係を自動インストール
pnpm build
openclaw onboard
```

完全ガイド：[はじめに](/start/getting-started)

## Windows コンパニオンアプリ

現時点では Windows コンパニオンアプリはありません。実現に向けたコントリビューションを歓迎します。
