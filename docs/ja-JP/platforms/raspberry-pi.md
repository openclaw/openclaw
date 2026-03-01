---
summary: "Raspberry Pi での OpenClaw（低コストのセルフホスティングセットアップ）"
read_when:
  - Raspberry Pi で OpenClaw をセットアップする
  - ARM デバイスで OpenClaw を実行する
  - 安価な常時稼働パーソナル AI を構築する
title: "Raspberry Pi"
---

# Raspberry Pi での OpenClaw

## 目標

Raspberry Pi 上で**約 $35-80** の一回限りのコスト（月額費用なし）で、持続的な常時稼働の OpenClaw Gateway を実行します。

最適な用途：

- 24 時間 365 日のパーソナル AI アシスタント
- ホームオートメーションハブ
- 低消費電力で常時利用可能な Telegram/WhatsApp ボット

## ハードウェア要件

| Pi モデル | RAM | 動作 | 備考 |
| --------------- | ------- | -------- | ---------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ 最適 | 最速、推奨                         |
| **Pi 4**        | 4GB     | ✅ 良好 | ほとんどのユーザーに最適           |
| **Pi 4**        | 2GB     | ✅ OK   | 動作、Swap を追加                  |
| **Pi 4**        | 1GB     | ⚠️ 厳しい | Swap と最小設定で動作可能         |
| **Pi 3B+**      | 1GB     | ⚠️ 遅い | 動作するが緩慢                     |
| **Pi Zero 2 W** | 512MB   | ❌       | 非推奨                             |

**最小スペック：** 1GB RAM、1 コア、500MB ディスク
**推奨：** 2GB 以上の RAM、64 ビット OS、16GB 以上の SD カード（または USB SSD）

## 必要なもの

- Raspberry Pi 4 または 5（2GB 以上推奨）
- MicroSD カード（16GB 以上）または USB SSD（パフォーマンスが向上）
- 電源（公式 Pi PSU 推奨）
- ネットワーク接続（Ethernet または WiFi）
- 約 30 分

## 1) OS をフラッシュする

**Raspberry Pi OS Lite（64 ビット）**を使用してください -- ヘッドレスサーバーにはデスクトップは不要です。

1. [Raspberry Pi Imager](https://www.raspberrypi.com/software/) をダウンロード
2. OS を選択：**Raspberry Pi OS Lite（64 ビット）**
3. 歯車アイコンをクリックして事前設定：
   - ホスト名を設定：`gateway-host`
   - SSH を有効化
   - ユーザー名/パスワードを設定
   - WiFi を設定（Ethernet を使用しない場合）
4. SD カード / USB ドライブにフラッシュ
5. Pi に挿入して起動

## 2) SSH で接続する

```bash
ssh user@gateway-host
# または IP アドレスを使用
ssh user@192.168.x.x
```

## 3) システムセットアップ

```bash
# システムを更新
sudo apt update && sudo apt upgrade -y

# 必須パッケージをインストール
sudo apt install -y git curl build-essential

# タイムゾーンを設定（cron/リマインダーに重要）
sudo timedatectl set-timezone America/Chicago  # お使いのタイムゾーンに変更してください
```

## 4) Node.js 22 をインストールする（ARM64）

```bash
# NodeSource 経由で Node.js をインストール
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 確認
node --version  # v22.x.x と表示されるはず
npm --version
```

## 5) Swap を追加する（2GB 以下の場合重要）

Swap はメモリ不足によるクラッシュを防ぎます：

```bash
# 2GB の Swap ファイルを作成
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# 永続化
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 低 RAM 向けに最適化（swappiness を下げる）
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6) OpenClaw をインストールする

### オプション A：標準インストール（推奨）

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### オプション B：ハッカブルインストール（カスタマイズ向け）

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

ハッカブルインストールはログとコードに直接アクセスできます -- ARM 固有の問題のデバッグに便利です。

## 7) オンボーディングを実行する

```bash
openclaw onboard --install-daemon
```

ウィザードに従います：

1. **Gateway モード：** Local
2. **認証：** API キー推奨（OAuth はヘッドレス Pi では不安定な場合があります）
3. **チャンネル：** 最初は Telegram が最も簡単
4. **デーモン：** はい（systemd）

## 8) インストールを確認する

```bash
# ステータスを確認
openclaw status

# サービスを確認
sudo systemctl status openclaw

# ログを表示
journalctl -u openclaw -f
```

## 9) ダッシュボードにアクセスする

Pi はヘッドレスなので、SSH トンネルを使用します：

```bash
# ラップトップ/デスクトップから
ssh -L 18789:localhost:18789 user@gateway-host

# その後ブラウザで開く
open http://localhost:18789
```

または Tailscale で常時アクセス可能にします：

```bash
# Pi 上で
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# 設定を更新
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## パフォーマンス最適化

### USB SSD を使用する（大幅な改善）

SD カードは低速で消耗します。USB SSD はパフォーマンスを劇的に向上させます：

```bash
# USB からブートしているか確認
lsblk
```

セットアップについては [Pi USB ブートガイド](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot)を参照してください。

### メモリ使用量を減らす

```bash
# GPU メモリ割り当てを無効にする（ヘッドレス）
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# 不要な場合は Bluetooth を無効にする
sudo systemctl disable bluetooth
```

### リソースを監視する

```bash
# メモリを確認
free -h

# CPU 温度を確認
vcgencmd measure_temp

# ライブモニタリング
htop
```

---

## ARM 固有の注意事項

### バイナリ互換性

ほとんどの OpenClaw 機能は ARM64 で動作しますが、一部の外部バイナリには ARM ビルドが必要な場合があります：

| ツール | ARM64 ステータス | 備考 |
| ------------------ | ------------ | ----------------------------------- |
| Node.js            | ✅           | 問題なく動作                        |
| WhatsApp (Baileys) | ✅           | 純粋な JS、問題なし                 |
| Telegram           | ✅           | 純粋な JS、問題なし                 |
| gog (Gmail CLI)    | ⚠️           | ARM リリースを確認                  |
| Chromium (ブラウザ) | ✅           | `sudo apt install chromium-browser` |

スキルが失敗した場合は、そのバイナリに ARM ビルドがあるか確認してください。多くの Go/Rust ツールにはありますが、ないものもあります。

### 32 ビット vs 64 ビット

**必ず 64 ビット OS を使用してください。** Node.js と多くの最新ツールは 64 ビットが必要です。以下で確認：

```bash
uname -m
# aarch64（64 ビット）と表示されるはず、armv7l（32 ビット）ではない
```

---

## 推奨モデルセットアップ

Pi は Gateway に過ぎない（モデルはクラウドで実行される）ため、API ベースのモデルを使用してください：

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

**Pi でローカル LLM を実行しようとしないでください** -- 小さなモデルでも遅すぎます。Claude/GPT に処理を任せてください。

---

## ブート時の自動起動

オンボーディングウィザードがこれを設定しますが、確認するには：

```bash
# サービスが有効か確認
sudo systemctl is-enabled openclaw

# 有効でない場合は有効にする
sudo systemctl enable openclaw

# ブート時に起動
sudo systemctl start openclaw
```

---

## トラブルシューティング

### メモリ不足（OOM）

```bash
# メモリを確認
free -h

# Swap を追加（ステップ 5 を参照）
# または Pi で実行中のサービスを減らす
```

### パフォーマンスが遅い

- SD カードの代わりに USB SSD を使用
- 未使用のサービスを無効にする：`sudo systemctl disable cups bluetooth avahi-daemon`
- CPU スロットリングを確認：`vcgencmd get_throttled`（`0x0` と表示されるはず）

### サービスが起動しない

```bash
# ログを確認
journalctl -u openclaw --no-pager -n 100

# よくある修正：リビルド
cd ~/openclaw  # ハッカブルインストールの場合
npm run build
sudo systemctl restart openclaw
```

### ARM バイナリの問題

スキルが「exec format error」で失敗する場合：

1. バイナリに ARM64 ビルドがあるか確認
2. ソースからビルドを試みる
3. または ARM サポートのある Docker コンテナを使用

### WiFi が切断される

ヘッドレス Pi での WiFi：

```bash
# WiFi のパワーマネジメントを無効にする
sudo iwconfig wlan0 power off

# 永続化
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## コスト比較

| セットアップ | 一回の費用 | 月額費用 | 備考 |
| -------------- | ------------- | ------------ | ------------------------- |
| **Pi 4 (2GB)** | ~$45          | $0           | + 電気代（年間約 $5）     |
| **Pi 4 (4GB)** | ~$55          | $0           | 推奨                      |
| **Pi 5 (4GB)** | ~$60          | $0           | 最高のパフォーマンス      |
| **Pi 5 (8GB)** | ~$80          | $0           | 過剰だが将来性あり        |
| DigitalOcean   | $0            | $6/月        | 年間 $72                  |
| Hetzner        | $0            | €3.79/月     | 年間約 $50                |

**損益分岐点：** Pi はクラウド VPS と比較して約 6-12 ヶ月で元が取れます。

---

## 関連項目

- [Linux ガイド](/platforms/linux) -- 一般的な Linux セットアップ
- [DigitalOcean ガイド](/platforms/digitalocean) -- クラウドの代替案
- [Hetzner ガイド](/install/hetzner) -- Docker セットアップ
- [Tailscale](/gateway/tailscale) -- リモートアクセス
- [ノード](/nodes) -- ラップトップ/スマートフォンを Pi Gateway にペアリング
