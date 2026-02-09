---
summary: "Ansible、Tailscale VPN、ファイアウォール分離を用いた、自動化され強化された OpenClaw のインストール"
read_when:
  - セキュリティ強化を伴う自動化されたサーバー展開を行いたい場合
  - VPN アクセス付きのファイアウォール分離セットアップが必要な場合
  - リモートの Debian/Ubuntu サーバーにデプロイする場合
title: "Ansible"
---

# Ansible インストール

本番サーバーに OpenClaw をデプロイする推奨方法は、**[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** を使用することです。これは、セキュリティ最優先のアーキテクチャを備えた自動インストーラーです。

## クイックスタート

ワンコマンドでインストールできます。

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 完全ガイド: [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> openclaw-ansible リポジトリは、Ansible デプロイの一次情報源です。このページは概要のみを示しています。 このページは簡単な概要です。

## あなたが得るもの

- 🔒 **ファイアウォール優先のセキュリティ**: UFW + Docker 分離（SSH と Tailscale のみアクセス可能）
- 🔐 **Tailscale VPN**: サービスを公開せずに安全なリモートアクセス
- 🐳 **Docker**: 分離されたサンドボックスコンテナ、localhost のみへのバインド
- 🛡️ **多層防御**: 4 層のセキュリティアーキテクチャ
- 🚀 **ワンコマンドセットアップ**: 数分で完全なデプロイ
- 🔧 **Systemd 連携**: 強化設定付きで起動時に自動起動

## 要件

- **OS**: Debian 11 以上、または Ubuntu 20.04 以上
- **アクセス**: root または sudo 権限
- **ネットワーク**: パッケージインストール用のインターネット接続
- **Ansible**: 2.14 以上（クイックスタートスクリプトにより自動インストール）

## インストールされる内容

Ansible プレイブックは以下をインストールおよび設定します。

1. **Tailscale**（安全なリモートアクセスのためのメッシュ VPN）
2. **UFW ファイアウォール**（SSH + Tailscale ポートのみ）
3. **Docker CE + Compose V2**（エージェントのサンドボックス用）
4. **Node.js 22.x + pnpm**（ランタイム依存関係）
5. **OpenClaw**（ホスト上で実行、コンテナ化しない）
6. **Systemd サービス**（セキュリティ強化付きの自動起動）

注記: ゲートウェイは **ホスト上で直接** 実行されます（Docker 内ではありません）が、エージェントのサンドボックスは分離のために Docker を使用します。詳細は [サンドボックス化](/gateway/sandboxing) を参照してください。 詳細は [Sandboxing](/gateway/sandboxing) を参照してください。

## インストール後のセットアップ

インストール完了後、openclaw ユーザーに切り替えます。

```bash
sudo -i -u openclaw
```

インストール後スクリプトでは、以下が案内されます。

1. **オンボーディングウィザード**: OpenClaw の設定
2. **プロバイダーログイン**: WhatsApp / Telegram / Discord / Signal の接続
3. **Gateway テスト**: インストールの検証
4. **Tailscale セットアップ**: VPN メッシュへの接続

### クイックコマンド

```bash
# Check service status
sudo systemctl status openclaw

# View live logs
sudo journalctl -u openclaw -f

# Restart gateway
sudo systemctl restart openclaw

# Provider login (run as openclaw user)
sudo -i -u openclaw
openclaw channels login
```

## セキュリティアーキテクチャ

### 4 層防御

1. **ファイアウォール（UFW）**: 公開されるのは SSH（22）と Tailscale（41641/udp）のみ
2. **VPN（Tailscale）**: Gateway は VPN メッシュ経由でのみアクセス可能
3. **Docker 分離**: DOCKER-USER の iptables チェーンにより外部ポート公開を防止
4. **Systemd 強化**: NoNewPrivileges、PrivateTmp、非特権ユーザー

### 検証

外部からの攻撃対象領域をテストします。

```bash
nmap -p- YOUR_SERVER_IP
```

**ポート 22**（SSH）のみが開いていることが表示されるはずです。その他のすべてのサービス（ゲートウェイ、Docker）はロックダウンされています。 他のすべてのサービス (ゲートウェイ、Docker) はロックダウンされています。

### Docker の利用範囲

Docker は **エージェントのサンドボックス**（分離されたツール実行）のためにインストールされます。ゲートウェイ自体の実行には使用されません。ゲートウェイは localhost のみにバインドされ、Tailscale VPN 経由でアクセスされます。 このゲートウェイは、localhostにのみバインドされ、Tailscale VPN経由でアクセスできます。

サンドボックスの設定については、[マルチエージェント サンドボックス & ツール](/tools/multi-agent-sandbox-tools) を参照してください。

## 手動インストール

自動化ではなく手動での制御を希望する場合は、以下を使用してください。

```bash
# 1. Install prerequisites
sudo apt update && sudo apt install -y ansible git

# 2. Clone repository
git clone https://github.com/openclaw/openclaw-ansible.git
cd openclaw-ansible

# 3. Install Ansible collections
ansible-galaxy collection install -r requirements.yml

# 4. Run playbook
./run-playbook.sh

# Or run directly (then manually execute /tmp/openclaw-setup.sh after)
# ansible-playbook playbook.yml --ask-become-pass
```

## OpenClaw の更新

Ansible インストーラーは、OpenClaw を手動更新できるようにセットアップします。標準的な更新手順については [更新](/install/updating) を参照してください。 標準の更新フローについては、 [Updating](/install/updating) を参照してください。

Ansible プレイブックを再実行する場合（例: 設定変更時）は、以下を実行します。

```bash
cd openclaw-ansible
./run-playbook.sh
```

注記: これは冪等であり、複数回実行しても安全です。

## トラブルシューティング

### ファイアウォールにより接続がブロックされる

ロックアウトされた場合は、以下を確認してください。

- まず Tailscale VPN 経由でアクセスできることを確認してください
- SSH アクセス（ポート 22）は常に許可されています
- ゲートウェイは設計上 **Tailscale 経由でのみ** アクセス可能です

### サービスが起動しない

```bash
# Check logs
sudo journalctl -u openclaw -n 100

# Verify permissions
sudo ls -la /opt/openclaw

# Test manual start
sudo -i -u openclaw
cd ~/openclaw
pnpm start
```

### Docker サンドボックスの問題

```bash
# Verify Docker is running
sudo systemctl status docker

# Check sandbox image
sudo docker images | grep openclaw-sandbox

# Build sandbox image if missing
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### プロバイダーログインに失敗する

`openclaw` ユーザーとして実行していることを確認してください。

```bash
sudo -i -u openclaw
openclaw channels login
```

## 高度な設定

詳細なセキュリティアーキテクチャおよびトラブルシューティングについては、以下を参照してください。

- [セキュリティアーキテクチャ](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [技術的詳細](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [トラブルシューティングガイド](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## 関連

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — 完全なデプロイガイド
- [Docker](/install/docker) — コンテナ化されたゲートウェイのセットアップ
- [サンドボックス化](/gateway/sandboxing) — エージェントのサンドボックス設定
- [マルチエージェント サンドボックス & ツール](/tools/multi-agent-sandbox-tools) — エージェントごとの分離
