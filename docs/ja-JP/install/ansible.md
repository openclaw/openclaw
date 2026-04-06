---
read_when:
    - セキュリティ強化を含む自動サーバーデプロイメントを行いたい場合
    - VPNアクセスによるファイアウォール分離セットアップが必要な場合
    - リモートのDebian/Ubuntuサーバーにデプロイする場合
summary: Ansible、Tailscale VPN、ファイアウォール分離による自動化・堅牢化されたOpenClawインストール
title: Ansible
x-i18n:
    generated_at: "2026-04-02T07:44:38Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 27433c3b4afa09406052e428be7b1990476067e47ab8abf7145ff9547b37909a
    source_path: install/ansible.md
    workflow: 15
---

# Ansibleインストール

**[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** を使用して、セキュリティファーストのアーキテクチャで本番サーバーにOpenClawをデプロイできます。

<Info>
[openclaw-ansible](https://github.com/openclaw/openclaw-ansible) リポジトリがAnsibleデプロイメントの信頼できる情報源です。このページは概要のみを説明します。
</Info>

## 前提条件

| 要件 | 詳細                                                   |
| ----------- | --------------------------------------------------------- |
| **OS**      | Debian 11以上またはUbuntu 20.04以上                               |
| **アクセス**  | rootまたはsudo権限                                   |
| **ネットワーク** | パッケージインストール用のインターネット接続              |
| **Ansible** | 2.14以上（クイックスタートスクリプトにより自動インストール） |

## 提供される機能

- **ファイアウォールファーストのセキュリティ** -- UFW + Docker分離（SSH + Tailscaleのみアクセス可能）
- **Tailscale VPN** -- サービスを公開せずにセキュアなリモートアクセス
- **Docker** -- 分離されたサンドボックスコンテナ、localhostのみのバインディング
- **多層防御** -- 4層セキュリティアーキテクチャ
- **Systemd統合** -- セキュリティ強化付きの起動時自動スタート
- **ワンコマンドセットアップ** -- 数分で完全なデプロイメント

## クイックスタート

ワンコマンドインストール：

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

## インストールされるもの

Ansibleプレイブックは以下をインストール・設定します：

1. **Tailscale** -- セキュアなリモートアクセス用メッシュVPN
2. **UFWファイアウォール** -- SSH + Tailscaleポートのみ
3. **Docker CE + Compose V2** -- エージェントサンドボックス用
4. **Node.js 24 + pnpm** -- ランタイム依存関係（Node 22 LTS、現在 `22.14+` もサポート継続）
5. **OpenClaw** -- ホストベース、コンテナ化なし
6. **Systemdサービス** -- セキュリティ強化付き自動スタート

<Note>
Gateway ゲートウェイはホスト上で直接実行されます（Docker内ではありません）が、エージェントのサンドボックスは分離のためにDockerを使用します。詳細は[サンドボックス化](/gateway/sandboxing)を参照してください。
</Note>

## インストール後のセットアップ

<Steps>
  <Step title="openclawユーザーに切り替え">
    ```bash
    sudo -i -u openclaw
    ```
  </Step>
  <Step title="オンボーディングウィザードを実行">
    インストール後のスクリプトがOpenClawの設定をガイドします。
  </Step>
  <Step title="メッセージングプロバイダーに接続">
    WhatsApp、Telegram、Discord、またはSignalにログインします：
    ```bash
    openclaw channels login
    ```
  </Step>
  <Step title="インストールを確認">
    ```bash
    sudo systemctl status openclaw
    sudo journalctl -u openclaw -f
    ```
  </Step>
  <Step title="Tailscaleに接続">
    セキュアなリモートアクセスのためにVPNメッシュに参加します。
  </Step>
</Steps>

### クイックコマンド

```bash
# サービスステータスの確認
sudo systemctl status openclaw

# ライブログの表示
sudo journalctl -u openclaw -f

# Gateway ゲートウェイの再起動
sudo systemctl restart openclaw

# プロバイダーログイン（openclawユーザーとして実行）
sudo -i -u openclaw
openclaw channels login
```

## セキュリティアーキテクチャ

このデプロイメントは4層の防御モデルを採用しています：

1. **ファイアウォール（UFW）** -- SSH（22）+ Tailscale（41641/udp）のみを公開
2. **VPN（Tailscale）** -- Gateway ゲートウェイはVPNメッシュ経由のみアクセス可能
3. **Docker分離** -- DOCKER-USER iptablesチェーンにより外部ポート公開を防止
4. **Systemd強化** -- NoNewPrivileges、PrivateTmp、非特権ユーザー

外部攻撃対象面を確認するには：

```bash
nmap -p- YOUR_SERVER_IP
```

ポート22（SSH）のみが開いているはずです。その他すべてのサービス（Gateway ゲートウェイ、Docker）はロックダウンされています。

Dockerはエージェントのサンドボックス（分離されたツール実行）用にインストールされており、Gateway ゲートウェイ自体の実行には使用されません。サンドボックスの設定については[マルチエージェントサンドボックスとツール](/tools/multi-agent-sandbox-tools)を参照してください。

## 手動インストール

自動化よりも手動で制御したい場合：

<Steps>
  <Step title="前提条件をインストール">
    ```bash
    sudo apt update && sudo apt install -y ansible git
    ```
  </Step>
  <Step title="リポジトリをクローン">
    ```bash
    git clone https://github.com/openclaw/openclaw-ansible.git
    cd openclaw-ansible
    ```
  </Step>
  <Step title="Ansibleコレクションをインストール">
    ```bash
    ansible-galaxy collection install -r requirements.yml
    ```
  </Step>
  <Step title="プレイブックを実行">
    ```bash
    ./run-playbook.sh
    ```

    または、直接実行してからセットアップスクリプトを手動で実行することもできます：
    ```bash
    ansible-playbook playbook.yml --ask-become-pass
    # その後実行: /tmp/openclaw-setup.sh
    ```

  </Step>
</Steps>

## 更新

Ansibleインストーラーは手動更新用にOpenClawをセットアップします。標準的な更新フローについては[更新](/install/updating)を参照してください。

Ansibleプレイブックを再実行するには（例：設定変更のため）：

```bash
cd openclaw-ansible
./run-playbook.sh
```

これは冪等であり、複数回実行しても安全です。

## トラブルシューティング

<AccordionGroup>
  <Accordion title="ファイアウォールが接続をブロックする">
    - まず Tailscale VPN経由でアクセスできることを確認してください
    - SSHアクセス（ポート22）は常に許可されています
    - Gateway ゲートウェイは設計上 Tailscale経由でのみアクセス可能です
  </Accordion>
  <Accordion title="サービスが起動しない">
    ```bash
    # ログを確認
    sudo journalctl -u openclaw -n 100

    # パーミッションを確認
    sudo ls -la /opt/openclaw

    # 手動起動をテスト
    sudo -i -u openclaw
    cd ~/openclaw
    openclaw gateway run
    ```

  </Accordion>
  <Accordion title="Dockerサンドボックスの問題">
    ```bash
    # Dockerが実行中か確認
    sudo systemctl status docker

    # サンドボックスイメージを確認
    sudo docker images | grep openclaw-sandbox

    # サンドボックスイメージが無い場合はビルド
    cd /opt/openclaw/openclaw
    sudo -u openclaw ./scripts/sandbox-setup.sh
    ```

  </Accordion>
  <Accordion title="プロバイダーログインが失敗する">
    `openclaw` ユーザーとして実行していることを確認してください：
    ```bash
    sudo -i -u openclaw
    openclaw channels login
    ```
  </Accordion>
</AccordionGroup>

## 高度な設定

セキュリティアーキテクチャとトラブルシューティングの詳細については、openclaw-ansibleリポジトリを参照してください：

- [セキュリティアーキテクチャ](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [技術的な詳細](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [トラブルシューティングガイド](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## 関連ページ

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) -- 完全なデプロイメントガイド
- [Docker](/install/docker) -- コンテナ化されたGateway ゲートウェイのセットアップ
- [サンドボックス化](/gateway/sandboxing) -- エージェントのサンドボックス設定
- [マルチエージェントサンドボックスとツール](/tools/multi-agent-sandbox-tools) -- エージェントごとの分離
