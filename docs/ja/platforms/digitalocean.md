---
summary: "DigitalOcean 上の OpenClaw（シンプルな有料 VPS オプション）"
read_when:
  - DigitalOcean で OpenClaw をセットアップする場合
  - OpenClaw 用の安価な VPS ホスティングを探している場合
title: "DigitalOcean"
---

# DigitalOcean 上の OpenClaw

## 目的

DigitalOcean 上で **$6/月**（予約価格で $4/月）の永続的な OpenClaw Gateway を実行します。

$0/月のオプションを希望し、ARM + プロバイダー固有のセットアップを気にしない場合は、[Oracle Cloud ガイド](/platforms/oracle) を参照してください。

## コスト比較（2026 年）

| プロバイダー       | プラン             | スペック               | 価格/月                        | 注記                 |
| ------------ | --------------- | ------------------ | --------------------------- | ------------------ |
| Oracle Cloud | Always Free ARM | 最大 4 OCPU、24GB RAM | $0                          | ARM、容量制限 / 登録時の癖あり |
| Hetzner      | CX22            | 2 vCPU、4GB RAM     | €3.79（約 $4） | 最安の有料オプション         |
| DigitalOcean | Basic           | 1 vCPU、1GB RAM     | $6                          | 簡単な UI、良質なドキュメント   |
| Vultr        | Cloud Compute   | 1 vCPU、1GB RAM     | $6                          | ロケーションが多数          |
| Linode       | Nanode          | 1 vCPU、1GB RAM     | $5                          | 現在は Akamai の一部     |

**プロバイダーの選び方：**

- DigitalOcean：最もシンプルな UX + 予測可能なセットアップ（本ガイド）
- Hetzner：価格/性能が良好（[Hetzner ガイド](/install/hetzner) を参照）
- Oracle Cloud：$0/月も可能ですが、やや癖があり ARM 専用（[Oracle ガイド](/platforms/oracle) を参照）

---

## 前提条件

- DigitalOcean アカウント（[$200 の無料クレジット付きで登録](https://m.do.co/c/signup)）
- SSH キーペア（またはパスワード認証を使用する意思）
- 約 20 分

## 1. Droplet を作成する

1. [DigitalOcean](https://cloud.digitalocean.com/) にログインします
2. **Create → Droplets** をクリックします
3. 次を選択します：
   - **Region:** 自分（またはユーザー）に最も近いリージョン
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **$6/月**（1 vCPU、1GB RAM、25GB SSD）
   - **Authentication:** SSH キー（推奨）またはパスワード
4. **Create Droplet** をクリックします
5. IP アドレスを控えます

## 2) SSH で接続する

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. OpenClaw をインストールする

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Install OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify
openclaw --version
```

## 4. オンボーディングを実行する

```bash
openclaw onboard --install-daemon
```

ウィザードでは次の内容を案内します：

- モデル認証（API キーまたは OAuth）
- チャンネル設定（Telegram、WhatsApp、Discord など）
- Gateway トークン（自動生成）
- デーモンのインストール（systemd）

## 5. Gateway を確認する

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. ダッシュボードにアクセスする

ゲートウェイはデフォルトでループバックにバインドされます。 Control UI にアクセスするには:

**オプション A：SSH トンネル（推奨）**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**オプション B：Tailscale Serve（HTTPS、loopback のみ）**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

開く：`https://<magicdns>/`

注記：

- Serve は Gateway を loopback のみに保ち、Tailscale の ID ヘッダーで認証します。
- 代わりにトークン/パスワードを必須にするには、`gateway.auth.allowTailscale: false` を設定するか、`gateway.auth.mode: "password"` を使用してください。

**オプション C：Tailnet バインド（Serve なし）**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

開く：`http://<tailscale-ip>:18789`（トークンが必要）。

## 7. チャンネルを接続する

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# Scan QR code
```

他のプロバイダーについては [Channels](/channels) を参照してください。

---

## 1GB RAM 向けの最適化

$6 の Droplet は 1GB RAM しかありません。安定して動作させるために： スムーズに動作させるには:

### swap を追加する（推奨）

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 軽量なモデルを使用する

OOM が発生する場合は、次を検討してください：

- ローカルモデルの代わりに API ベースのモデル（Claude、GPT）を使用する
- `agents.defaults.model.primary` をより小さなモデルに設定する

### メモリを監視する

```bash
free -h
htop
```

---

## 永続化

すべての状態は次の場所に保存されます：

- `~/.openclaw/` — 設定、認証情報、セッションデータ
- `~/.openclaw/workspace/` — ワークスペース（SOUL.md、メモリなど）

これらの生き残るリブート。 これらは再起動後も保持されます。定期的にバックアップしてください：

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle Cloud の無料代替案

Oracle Cloud は **Always Free** の ARM インスタンスを提供しており、ここに挙げたどの有料オプションよりも大幅に高性能です — $0/月。

| あなたが得るもの        | スペック          |
| --------------- | ------------- |
| **4 OCPU**      | ARM Ampere A1 |
| **24GB RAM**    | 十分すぎる容量       |
| **200GB ストレージ** | ブロックボリューム     |
| **永久無料**        | クレジットカード請求なし  |

**注意点：**

- 登録が不安定な場合があります（失敗したら再試行してください）
- ARM アーキテクチャ — 多くは動作しますが、一部のバイナリは ARM ビルドが必要です

完全なセットアップガイドについては [Oracle Cloud](/platforms/oracle) を参照してください。登録のコツや登録プロセスのトラブルシューティングについては、この [コミュニティガイド](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) を参照してください。 37. サインアップのヒントや登録プロセスのトラブルシューティングについては、この [コミュニティガイド](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) を参照してください。

---

## トラブルシューティング

### Gateway が起動しない

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### ポートが既に使用中

```bash
lsof -i :18789
kill <PID>
```

### メモリ不足

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## See Also

- [Hetzner ガイド](/install/hetzner) — より安価で高性能
- [Docker インストール](/install/docker) — コンテナ化されたセットアップ
- [Tailscale](/gateway/tailscale) — 安全なリモートアクセス
- [設定](/gateway/configuration) — 完全な設定リファレンス
