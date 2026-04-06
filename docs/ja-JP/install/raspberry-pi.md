---
read_when:
    - Raspberry PiにOpenClawをセットアップする場合
    - ARMデバイスでOpenClawを実行する場合
    - 安価な常時稼働のパーソナルAIを作る場合
summary: 常時稼働のセルフホスティングのためにRaspberry PiでOpenClawをホストする
title: Raspberry Pi
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 6afe3fcd2ed3e868990e81d409d73a84d72b628be557fc83b2530483fff898bf
    source_path: install/raspberry-pi.md
    workflow: 15
---

# Raspberry Pi

Raspberry Piで永続的な常時稼働のOpenClaw Gateway ゲートウェイを実行します。PiはGateway ゲートウェイとしてのみ機能し（モデルはAPI経由でクラウドで実行）、控えめなPiでもワークロードをこなせます。

## 前提条件

- Raspberry Pi 4または5（RAM 2 GB以上; 4 GB推奨）
- MicroSDカード（16 GB以上）またはUSB SSD（パフォーマンス向上）
- 公式Pi電源
- ネットワーク接続（EthernetまたはWiFi）
- 64ビットRaspberry Pi OS（必須 -- 32ビットは使用しないこと）
- 約30分

## セットアップ

<Steps>
  <Step title="OSをフラッシュ">
    **Raspberry Pi OS Lite（64ビット）** -- ヘッドレスサーバーにはデスクトップ不要。

    1. [Raspberry Pi Imager](https://www.raspberrypi.com/software/)をダウンロード。
    2. OS選択: **Raspberry Pi OS Lite（64ビット）**。
    3. 設定ダイアログで事前設定：
       - ホスト名: `gateway-host`
       - SSHを有効化
       - ユーザー名とパスワードを設定
       - WiFiを設定（Ethernetを使用しない場合）
    4. SDカードまたはUSBドライブにフラッシュし、挿入してPiを起動。

  </Step>

  <Step title="SSHで接続">
    ```bash
    ssh user@gateway-host
    ```
  </Step>

  <Step title="システムを更新">
    ```bash
    sudo apt update && sudo apt upgrade -y
    sudo apt install -y git curl build-essential

    # タイムゾーンを設定（cronやリマインダーに重要）
    sudo timedatectl set-timezone Asia/Tokyo
    ```

  </Step>

  <Step title="Node.js 24をインストール">
    ```bash
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt install -y nodejs
    node --version
    ```
  </Step>

  <Step title="スワップを追加（2 GB以下の場合は重要）">
    ```bash
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

    # 低RAMデバイスのスワップ頻度を下げる
    echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
    sudo sysctl -p
    ```

  </Step>

  <Step title="OpenClawをインストール">
    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash
    ```
  </Step>

  <Step title="オンボーディングを実行">
    ```bash
    openclaw onboard --install-daemon
    ```

    ウィザードに従ってください。ヘッドレスデバイスにはOAuthよりAPIキーが推奨されます。Telegramが最も始めやすいチャネルです。

  </Step>

  <Step title="確認">
    ```bash
    openclaw status
    sudo systemctl status openclaw
    journalctl -u openclaw -f
    ```
  </Step>

  <Step title="Control UIにアクセス">
    コンピューターでPiからダッシュボードURLを取得：

    ```bash
    ssh user@gateway-host 'openclaw dashboard --no-open'
    ```

    別のターミナルでSSHトンネルを作成：

    ```bash
    ssh -N -L 18789:127.0.0.1:18789 user@gateway-host
    ```

    表示されたURLをローカルブラウザで開いてください。常時稼働のリモートアクセスには[Tailscale連携](/gateway/tailscale)を参照してください。

  </Step>
</Steps>

## パフォーマンスのヒント

**USB SSDを使用** -- SDカードは遅く消耗しやすいです。USB SSDはパフォーマンスを大幅に向上させます。[Pi USBブートガイド](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot)を参照。

**モジュールコンパイルキャッシュを有効化** -- 低電力PiホストでのCLI繰り返し呼び出しを高速化：

```bash
grep -q 'NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache' ~/.bashrc || cat >> ~/.bashrc <<'EOF' # pragma: allowlist secret
export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
mkdir -p /var/tmp/openclaw-compile-cache
export OPENCLAW_NO_RESPAWN=1
EOF
source ~/.bashrc
```

**メモリ使用量を削減** -- ヘッドレスセットアップでは、GPUメモリを解放し未使用のサービスを無効化：

```bash
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt
sudo systemctl disable bluetooth
```

## トラブルシューティング

**メモリ不足** -- `free -h`でスワップがアクティブか確認。未使用のサービスを無効化（`sudo systemctl disable cups bluetooth avahi-daemon`）。APIベースのモデルのみを使用。

**パフォーマンスが遅い** -- SDカードの代わりにUSB SSDを使用。`vcgencmd get_throttled`でCPUスロットリングを確認（`0x0`が返るべき）。

**サービスが起動しない** -- `journalctl -u openclaw --no-pager -n 100`でログを確認し、`openclaw doctor --non-interactive`を実行。

**ARMバイナリの問題** -- スキルが「exec format error」で失敗する場合は、バイナリにARM64ビルドがあるか確認。`uname -m`でアーキテクチャを確認（`aarch64`が表示されるべき）。

**WiFiが切れる** -- WiFiパワーマネジメントを無効化: `sudo iwconfig wlan0 power off`

## 次のステップ

- [チャネル](/channels) -- Telegram、WhatsApp、Discordなどに接続
- [Gateway ゲートウェイ設定](/gateway/configuration) -- すべての設定オプション
- [アップデート](/install/updating) -- OpenClawを最新に保つ
