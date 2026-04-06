---
read_when:
    - Raspberry PiでOpenClawをセットアップする場合
    - ARMデバイスでOpenClawを実行する場合
    - 安価な常時稼働パーソナルAIを構築する場合
summary: Raspberry Pi上のOpenClaw（低コストなセルフホスト構成）
title: Raspberry Pi（プラットフォーム）
x-i18n:
    generated_at: "2026-04-02T08:35:47Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 74d4808595d3434afa1a9ea22d885124da30fcedd0cba6e355b114852a18a060
    source_path: platforms/raspberry-pi.md
    workflow: 15
---

# Raspberry Pi上のOpenClaw

## 目的

Raspberry Pi上で常時稼働のOpenClaw Gateway ゲートウェイを**約35〜80ドル**の初期費用のみ（月額費用なし）で運用する。

最適な用途:

- 24時間365日稼働のパーソナルAIアシスタント
- ホームオートメーションハブ
- 低消費電力で常時利用可能なTelegram/WhatsAppボット

## ハードウェア要件

| Piモデル         | RAM     | 動作可否      | 備考                               |
| --------------- | ------- | ------------ | ---------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ 最適      | 最速、推奨                          |
| **Pi 4**        | 4GB     | ✅ 良好      | ほとんどのユーザーに最適なバランス      |
| **Pi 4**        | 2GB     | ✅ 可        | 動作する、スワップを追加推奨           |
| **Pi 4**        | 1GB     | ⚠️ 厳しい    | スワップと最小構成で動作可能           |
| **Pi 3B+**      | 1GB     | ⚠️ 低速      | 動作するが遅い                       |
| **Pi Zero 2 W** | 512MB   | ❌           | 非推奨                              |

**最小スペック:** 1GB RAM、1コア、500MBディスク
**推奨:** 2GB以上のRAM、64ビットOS、16GB以上のSDカード（またはUSB SSD）

## 必要なもの

- Raspberry Pi 4または5（2GB以上推奨）
- MicroSDカード（16GB以上）またはUSB SSD（より高性能）
- 電源（Pi公式電源アダプター推奨）
- ネットワーク接続（イーサネットまたはWiFi）
- 約30分の時間

## 1) OSの書き込み

**Raspberry Pi OS Lite（64ビット）**を使用する — ヘッドレスサーバーにはデスクトップ環境は不要。

1. [Raspberry Pi Imager](https://www.raspberrypi.com/software/)をダウンロード
2. OSを選択: **Raspberry Pi OS Lite（64ビット）**
3. 歯車アイコン（⚙️）をクリックして事前設定:
   - ホスト名を設定: `gateway-host`
   - SSHを有効化
   - ユーザー名/パスワードを設定
   - WiFiを設定（イーサネットを使用しない場合）
4. SDカード / USBドライブに書き込み
5. Piに挿入して起動

## 2) SSH接続

```bash
ssh user@gateway-host
# またはIPアドレスを使用
ssh user@192.168.x.x
```

## 3) システムセットアップ

```bash
# システムを更新
sudo apt update && sudo apt upgrade -y

# 必須パッケージをインストール
sudo apt install -y git curl build-essential

# タイムゾーンを設定（cron/リマインダーに重要）
sudo timedatectl set-timezone America/Chicago  # 自分のタイムゾーンに変更
```

## 4) Node.js 24のインストール（ARM64）

```bash
# NodeSource経由でNode.jsをインストール
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs

# 確認
node --version  # v24.x.xと表示されるはず
npm --version
```

## 5) スワップの追加（2GB以下では重要）

スワップによりメモリ不足によるクラッシュを防止する:

```bash
# 2GBのスワップファイルを作成
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# 永続化
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 低RAM向けに最適化（スワップ使用頻度を低減）
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6) OpenClawのインストール

### オプションA: 標準インストール（推奨）

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### オプションB: ハック可能なインストール（カスタマイズ向け）

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

ハック可能なインストールではログとコードに直接アクセスでき、ARM固有の問題のデバッグに役立つ。

## 7) オンボーディングの実行

```bash
openclaw onboard --install-daemon
```

ウィザードの手順に従う:

1. **Gateway ゲートウェイモード:** ローカル
2. **認証:** APIキー推奨（OAuthはヘッドレスPiでは不安定な場合がある）
3. **チャネル:** Telegramが最も簡単
4. **デーモン:** はい（systemd）

## 8) インストールの確認

```bash
# ステータスを確認
openclaw status

# サービスを確認
sudo systemctl status openclaw

# ログを表示
journalctl -u openclaw -f
```

## 9) OpenClawダッシュボードへのアクセス

`user@gateway-host` はPiのユーザー名とホスト名またはIPアドレスに置き換えること。

自分のコンピューターから、Piにダッシュボードの新しいURLを表示させる:

```bash
ssh user@gateway-host 'openclaw dashboard --no-open'
```

コマンドが `Dashboard URL:` を出力する。`gateway.auth.token` の設定によって、URLはプレーンな `http://127.0.0.1:18789/` リンクか、`#token=...` を含むものになる。

自分のコンピューターの別のターミナルでSSHトンネルを作成する:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@gateway-host
```

次に、表示されたダッシュボードURLをローカルブラウザで開く。

UIが認証を求めた場合、`gateway.auth.token`（または `OPENCLAW_GATEWAY_TOKEN`）のトークンをControl UI設定に貼り付ける。

常時リモートアクセスについては、[Tailscale](/gateway/tailscale)を参照。

---

## パフォーマンス最適化

### USB SSDの使用（大幅な改善）

SDカードは低速で消耗する。USB SSDにするとパフォーマンスが劇的に向上する:

```bash
# USBから起動しているか確認
lsblk
```

セットアップ方法は[Pi USB起動ガイド](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot)を参照。

### CLI起動の高速化（モジュールコンパイルキャッシュ）

低スペックなPiホストでは、Nodeのモジュールコンパイルキャッシュを有効にすることでCLIの繰り返し実行が高速になる:

```bash
grep -q 'NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache' ~/.bashrc || cat >> ~/.bashrc <<'EOF' # pragma: allowlist secret
export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
mkdir -p /var/tmp/openclaw-compile-cache
export OPENCLAW_NO_RESPAWN=1
EOF
source ~/.bashrc
```

注意事項:

- `NODE_COMPILE_CACHE` は以降の実行（`status`、`health`、`--help`）を高速化する。
- `/var/tmp` は `/tmp` よりも再起動後もデータが保持されやすい。
- `OPENCLAW_NO_RESPAWN=1` はCLIの自己リスポーンによる追加の起動コストを回避する。
- 初回実行でキャッシュがウォームアップされ、以降の実行で効果を発揮する。

### systemd起動チューニング（オプション）

このPiが主にOpenClawの実行に使用される場合、サービスのドロップインを追加してリスタートのジッターを減らし、起動環境を安定させる:

```bash
sudo systemctl edit openclaw
```

```ini
[Service]
Environment=OPENCLAW_NO_RESPAWN=1
Environment=NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
Restart=always
RestartSec=2
TimeoutStartSec=90
```

次に適用する:

```bash
sudo systemctl daemon-reload
sudo systemctl restart openclaw
```

可能であれば、コールドスタート時のSDカードのランダムI/Oボトルネックを避けるため、OpenClawの状態/キャッシュをSSDベースのストレージに保持する。

`Restart=` ポリシーによる自動復旧の仕組み:
[systemdはサービスの自動復旧を実現できる](https://www.redhat.com/en/blog/systemd-automate-recovery)。

### メモリ使用量の削減

```bash
# GPUメモリ割り当てを無効化（ヘッドレス）
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# 不要ならBluetoothを無効化
sudo systemctl disable bluetooth
```

### リソースの監視

```bash
# メモリを確認
free -h

# CPU温度を確認
vcgencmd measure_temp

# リアルタイム監視
htop
```

---

## ARM固有の注意事項

### バイナリ互換性

OpenClawのほとんどの機能はARM64で動作するが、一部の外部バイナリにはARMビルドが必要な場合がある:

| ツール              | ARM64対応状況 | 備考                                  |
| ------------------- | ------------ | ------------------------------------- |
| Node.js             | ✅           | 問題なく動作                           |
| WhatsApp (Baileys)  | ✅           | 純粋なJS、問題なし                     |
| Telegram            | ✅           | 純粋なJS、問題なし                     |
| gog (Gmail CLI)     | ⚠️           | ARMリリースの有無を確認                 |
| Chromium (ブラウザ)  | ✅           | `sudo apt install chromium-browser`   |

Skillが失敗した場合、そのバイナリにARMビルドがあるか確認すること。多くのGo/Rustツールは対応しているが、対応していないものもある。

### 32ビットと64ビット

**必ず64ビットOSを使用すること。** Node.jsや多くの最新ツールが必要とする。以下で確認:

```bash
uname -m
# aarch64（64ビット）と表示されるべき、armv7l（32ビット）ではない
```

---

## 推奨モデル設定

Piは Gateway ゲートウェイとしてのみ動作し（モデルはクラウドで実行される）、APIベースのモデルを使用する:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-20250514",
        "fallbacks": ["openai/gpt-4o-mini"]
      }
    }
  }
}
```

**Piでローカル LLMを実行しようとしないこと** — 小さなモデルでも遅すぎる。重い処理はClaude/GPTに任せる。

---

## 起動時の自動開始

オンボーディングで設定されるが、確認するには:

```bash
# サービスが有効か確認
sudo systemctl is-enabled openclaw

# 有効でない場合は有効化
sudo systemctl enable openclaw

# 起動時に開始
sudo systemctl start openclaw
```

---

## トラブルシューティング

### メモリ不足（OOM）

```bash
# メモリを確認
free -h

# スワップを追加（ステップ5を参照）
# またはPiで実行中のサービスを減らす
```

### パフォーマンスが遅い

- SDカードの代わりにUSB SSDを使用する
- 不要なサービスを無効化: `sudo systemctl disable cups bluetooth avahi-daemon`
- CPUスロットリングを確認: `vcgencmd get_throttled`（`0x0` が返されるべき）

### サービスが起動しない

```bash
# ログを確認
journalctl -u openclaw --no-pager -n 100

# 一般的な修正方法: リビルド
cd ~/openclaw  # ハック可能なインストールの場合
npm run build
sudo systemctl restart openclaw
```

### ARMバイナリの問題

Skillが「exec format error」で失敗する場合:

1. そのバイナリにARM64ビルドがあるか確認する
2. ソースからビルドを試みる
3. またはARM対応のDockerコンテナを使用する

### WiFiの切断

ヘッドレスPiでWiFiを使用する場合:

```bash
# WiFi省電力機能を無効化
sudo iwconfig wlan0 power off

# 永続化
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## コスト比較

| 構成             | 初期費用       | 月額費用      | 備考                      |
| --------------- | ------------- | ------------ | ------------------------- |
| **Pi 4 (2GB)**  | 約45ドル       | 0ドル        | ＋電気代（年間約5ドル）      |
| **Pi 4 (4GB)**  | 約55ドル       | 0ドル        | 推奨                      |
| **Pi 5 (4GB)**  | 約60ドル       | 0ドル        | 最高のパフォーマンス        |
| **Pi 5 (8GB)**  | 約80ドル       | 0ドル        | オーバースペックだが将来性あり |
| DigitalOcean    | 0ドル          | 月6ドル      | 年間72ドル                 |
| Hetzner         | 0ドル          | 月3.79ユーロ  | 年間約50ドル               |

**損益分岐点:** Piはクラウド VPSと比較して約6〜12か月で元が取れる。

---

## 関連項目

- [Linuxガイド](/platforms/linux) — 一般的なLinuxセットアップ
- [DigitalOceanガイド](/platforms/digitalocean) — クラウドの代替手段
- [Hetznerガイド](/install/hetzner) — Dockerセットアップ
- [Tailscale](/gateway/tailscale) — リモートアクセス
- [ノード](/nodes) — ノートPC/スマートフォンをPi Gateway ゲートウェイとペアリング
