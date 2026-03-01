---
summary: "Ansible、Tailscale VPN、ファイアウォール隔離による自動化・強化されたOpenClawインストール"
read_when:
  - セキュリティ強化を伴う自動サーバーデプロイメントが必要な場合
  - VPNアクセスによるファイアウォール隔離セットアップが必要な場合
  - リモートのDebian/Ubuntuサーバーにデプロイする場合
title: "Ansible"
---

# Ansibleインストール

本番サーバーにOpenClawをデプロイする推奨方法は、**[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**を使用することです。セキュリティファーストのアーキテクチャを備えた自動インストーラーです。

## クイックスタート

ワンコマンドインストール：

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **完全ガイド：[github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> openclaw-ansibleリポジトリがAnsibleデプロイメントの正本です。このページはクイック概要です。

## 得られるもの

- **ファイアウォールファーストのセキュリティ**：UFW + Docker隔離（SSHとTailscaleのみアクセス可能）
- **Tailscale VPN**：サービスをパブリックに公開せずに安全なリモートアクセス
- **Docker**：隔離されたサンドボックスコンテナ、ローカルホストのみのバインド
- **多層防御**：4層セキュリティアーキテクチャ
- **ワンコマンドセットアップ**：数分で完全なデプロイメント
- **Systemd統合**：ハードニングを伴うブート時の自動起動

## 要件

- **OS**：Debian 11+ または Ubuntu 20.04+
- **アクセス**：root権限またはsudo権限
- **ネットワーク**：パッケージインストール用のインターネット接続
- **Ansible**：2.14+（クイックスタートスクリプトにより自動インストール）

## インストールされるもの

Ansibleプレイブックは以下をインストールし設定します：

1. **Tailscale**（安全なリモートアクセス用メッシュVPN）
2. **UFWファイアウォール**（SSH + Tailscaleポートのみ）
3. **Docker CE + Compose V2**（エージェントサンドボックス用）
4. **Node.js 22.x + pnpm**（ランタイム依存関係）
5. **OpenClaw**（ホストベース、コンテナ化されていない）
6. **Systemdサービス**（セキュリティハードニング付き自動起動）

注意：Gatewayは**ホスト上で直接**実行されます（Dockerではありません）が、エージェントサンドボックスは隔離のためにDockerを使用します。詳細は[サンドボックス](/gateway/sandboxing)を参照してください。

## インストール後のセットアップ

インストール完了後、openclawユーザーに切り替えてください：

```bash
sudo -i -u openclaw
```

インストール後スクリプトが以下の手順をガイドします：

1. **オンボーディングウィザード**：OpenClawの設定
2. **プロバイダーログイン**：WhatsApp/Telegram/Discord/Signalの接続
3. **Gatewayテスト**：インストールの検証
4. **Tailscaleセットアップ**：VPNメッシュへの接続

### クイックコマンド

```bash
# サービスの状態確認
sudo systemctl status openclaw

# ライブログの表示
sudo journalctl -u openclaw -f

# Gatewayの再起動
sudo systemctl restart openclaw

# プロバイダーログイン（openclawユーザーとして実行）
sudo -i -u openclaw
openclaw channels login
```

## セキュリティアーキテクチャ

### 4層防御

1. **ファイアウォール（UFW）**：SSH（22）+ Tailscale（41641/udp）のみパブリックに公開
2. **VPN（Tailscale）**：GatewayはVPNメッシュ経由でのみアクセス可能
3. **Docker隔離**：DOCKER-USER iptablesチェーンが外部ポート公開を防止
4. **Systemdハードニング**：NoNewPrivileges、PrivateTmp、非特権ユーザー

### 検証

外部攻撃対象を テスト：

```bash
nmap -p- YOUR_SERVER_IP
```

**ポート22（SSH）のみ**が開いているはずです。その他のサービス（Gateway、Docker）はすべてロックダウンされています。

### Dockerの利用可能性

Dockerは**エージェントサンドボックス**（隔離されたツール実行）用にインストールされ、Gateway自体の実行用ではありません。Gatewayはローカルホストにのみバインドし、Tailscale VPN経由でアクセスできます。

サンドボックスの設定については[マルチエージェントサンドボックス&ツール](/tools/multi-agent-sandbox-tools)を参照してください。

## 手動インストール

自動化よりも手動制御を好む場合：

```bash
# 1. 前提条件のインストール
sudo apt update && sudo apt install -y ansible git

# 2. リポジトリのクローン
git clone https://github.com/openclaw/openclaw-ansible.git
cd openclaw-ansible

# 3. Ansibleコレクションのインストール
ansible-galaxy collection install -r requirements.yml

# 4. プレイブックの実行
./run-playbook.sh

# または直接実行（その後手動で/tmp/openclaw-setup.shを実行）
# ansible-playbook playbook.yml --ask-become-pass
```

## OpenClawのアップデート

Ansibleインストーラーは手動アップデート用にOpenClawをセットアップします。標準的なアップデートフローについては[アップデート](/install/updating)を参照してください。

Ansibleプレイブックを再実行するには（例：設定変更の場合）：

```bash
cd openclaw-ansible
./run-playbook.sh
```

注意：これは冪等であり、複数回安全に実行できます。

## トラブルシューティング

### ファイアウォールが接続をブロックする

ロックアウトされた場合：

- まずTailscale VPN経由でアクセスできることを確認してください
- SSHアクセス（ポート22）は常に許可されます
- Gatewayは設計上Tailscale経由で**のみ**アクセス可能です

### サービスが起動しない

```bash
# ログの確認
sudo journalctl -u openclaw -n 100

# パーミッションの確認
sudo ls -la /opt/openclaw

# 手動起動のテスト
sudo -i -u openclaw
cd ~/openclaw
pnpm start
```

### Dockerサンドボックスの問題

```bash
# Dockerが実行中か確認
sudo systemctl status docker

# サンドボックスイメージの確認
sudo docker images | grep openclaw-sandbox

# サンドボックスイメージがない場合はビルド
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### プロバイダーログインが失敗する

`openclaw`ユーザーとして実行していることを確認してください：

```bash
sudo -i -u openclaw
openclaw channels login
```

## 高度な設定

詳細なセキュリティアーキテクチャとトラブルシューティングについて：

- [セキュリティアーキテクチャ](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [技術的な詳細](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [トラブルシューティングガイド](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## 関連情報

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — 完全デプロイメントガイド
- [Docker](/install/docker) — コンテナ化Gatewayセットアップ
- [サンドボックス](/gateway/sandboxing) — エージェントサンドボックスの設定
- [マルチエージェントサンドボックス&ツール](/tools/multi-agent-sandbox-tools) — エージェントごとの隔離
