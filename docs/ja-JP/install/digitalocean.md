---
read_when:
    - DigitalOceanでOpenClawをセットアップする場合
    - OpenClaw用のシンプルな有料VPSを探している場合
summary: DigitalOcean DropletでOpenClawをホストする
title: DigitalOcean
x-i18n:
    generated_at: "2026-04-02T07:44:59Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 4b161db8ec643d8313938a2453ce6242fc1ee8ea1fd2069916276f1aadeb71f1
    source_path: install/digitalocean.md
    workflow: 15
---

# DigitalOcean

DigitalOcean Droplet上で永続的なOpenClaw Gateway ゲートウェイを実行します。

## 前提条件

- DigitalOceanアカウント（[サインアップ](https://cloud.digitalocean.com/registrations/new)）
- SSHキーペア（またはパスワード認証を使用する意向）
- 約20分

## セットアップ

<Steps>
  <Step title="Dropletを作成する">
    <Warning>
    クリーンなベースイメージ（Ubuntu 24.04 LTS）を使用してください。サードパーティのMarketplaceワンクリックイメージは、スタートアップスクリプトとファイアウォールのデフォルト設定を確認していない限り避けてください。
    </Warning>

    1. [DigitalOcean](https://cloud.digitalocean.com/)にログインします。
    2. **Create > Droplets**をクリックします。
    3. 以下を選択します：
       - **Region:** 最寄りのリージョン
       - **Image:** Ubuntu 24.04 LTS
       - **Size:** Basic、Regular、1 vCPU / 1 GB RAM / 25 GB SSD
       - **Authentication:** SSHキー（推奨）またはパスワード
    4. **Create Droplet**をクリックし、IPアドレスをメモします。

  </Step>

  <Step title="接続してインストールする">
    ```bash
    ssh root@YOUR_DROPLET_IP

    apt update && apt upgrade -y

    # Node.js 24をインストール
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt install -y nodejs

    # OpenClawをインストール
    curl -fsSL https://openclaw.ai/install.sh | bash
    openclaw --version
    ```

  </Step>

  <Step title="オンボーディングを実行する">
    ```bash
    openclaw onboard --install-daemon
    ```

    ウィザードがモデル認証、チャネルセットアップ、Gateway ゲートウェイトークンの生成、デーモンのインストール（systemd）を案内します。

  </Step>

  <Step title="スワップを追加する（1 GB Dropletの場合推奨）">
    ```bash
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ```
  </Step>

  <Step title="Gateway ゲートウェイを確認する">
    ```bash
    openclaw status
    systemctl --user status openclaw-gateway.service
    journalctl --user -u openclaw-gateway.service -f
    ```
  </Step>

  <Step title="コントロールUIにアクセスする">
    Gateway ゲートウェイはデフォルトでループバックにバインドします。以下のオプションのいずれかを選択してください。

    **オプションA：SSHトンネル（最も簡単）**

    ```bash
    # ローカルマシンから
    ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP
    ```

    次に`http://localhost:18789`を開きます。

    **オプションB：Tailscale Serve**

    ```bash
    curl -fsSL https://tailscale.com/install.sh | sh
    tailscale up
    openclaw config set gateway.tailscale.mode serve
    openclaw gateway restart
    ```

    次にtailnet上の任意のデバイスから`https://<magicdns>/`を開きます。

    **オプションC：Tailnetバインド（Serveなし）**

    ```bash
    openclaw config set gateway.bind tailnet
    openclaw gateway restart
    ```

    次に`http://<tailscale-ip>:18789`を開きます（トークンが必要）。

  </Step>
</Steps>

## トラブルシューティング

**Gateway ゲートウェイが起動しない** -- `openclaw doctor --non-interactive`を実行し、`journalctl --user -u openclaw-gateway.service -n 50`でログを確認してください。

**ポートが既に使用中** -- `lsof -i :18789`を実行してプロセスを特定し、停止してください。

**メモリ不足** -- `free -h`でスワップが有効であることを確認してください。それでもOOMが発生する場合は、ローカルモデルではなくAPIベースのモデル（Claude、GPT）を使用するか、2 GB Dropletにアップグレードしてください。

## 次のステップ

- [チャネル](/channels) -- Telegram、WhatsApp、Discordなどを接続する
- [Gateway ゲートウェイの設定](/gateway/configuration) -- すべての設定オプション
- [アップデート](/install/updating) -- OpenClawを最新の状態に保つ
