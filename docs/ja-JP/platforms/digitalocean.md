---
summary: "DigitalOcean での OpenClaw（シンプルな有料 VPS オプション）"
read_when:
  - DigitalOcean で OpenClaw をセットアップする
  - OpenClaw 向けの安価な VPS ホスティングを探している
title: "DigitalOcean"
---

# DigitalOcean での OpenClaw

## 目標

DigitalOcean 上で **月額 $6**（リザーブド価格なら月額 $4）の持続的な OpenClaw Gateway を実行します。

月額 $0 のオプションで ARM + プロバイダー固有のセットアップを気にしない場合は、[Oracle Cloud ガイド](/platforms/oracle) を参照してください。

## コスト比較（2026年）

| プロバイダー | プラン | スペック | 月額 | 備考 |
| ------------ | --------------- | ---------------------- | ----------- | ------------------------------------- |
| Oracle Cloud | Always Free ARM | 最大 4 OCPU、24GB RAM | $0          | ARM、容量制限 / サインアップの癖あり |
| Hetzner      | CX22            | 2 vCPU、4GB RAM        | €3.79 (~$4) | 最安の有料オプション                  |
| DigitalOcean | Basic           | 1 vCPU、1GB RAM        | $6          | 簡単な UI、良いドキュメント           |
| Vultr        | Cloud Compute   | 1 vCPU、1GB RAM        | $6          | 多くのロケーション                    |
| Linode       | Nanode          | 1 vCPU、1GB RAM        | $5          | 現在 Akamai の一部                    |

**プロバイダーの選び方：**

- DigitalOcean：最もシンプルな UX + 予測可能なセットアップ（このガイド）
- Hetzner：コストパフォーマンスが良い（[Hetzner ガイド](/install/hetzner) を参照）
- Oracle Cloud：月額 $0 が可能だが、やや扱いにくく ARM のみ（[Oracle ガイド](/platforms/oracle) を参照）

---

## 前提条件

- DigitalOcean アカウント（[$200 の無料クレジット付きサインアップ](https://m.do.co/c/signup)）
- SSH キーペア（またはパスワード認証の使用）
- 約 20 分

## 1) Droplet を作成する

<Warning>
クリーンなベースイメージ（Ubuntu 24.04 LTS）を使用してください。サードパーティの Marketplace ワンクリックイメージは、スタートアップスクリプトとファイアウォールのデフォルト設定を確認していない限り避けてください。
</Warning>

1. [DigitalOcean](https://cloud.digitalocean.com/) にログイン
2. **Create → Droplets** をクリック
3. 以下を選択：
   - **リージョン：** 最も近い場所（またはユーザーに近い場所）
   - **イメージ：** Ubuntu 24.04 LTS
   - **サイズ：** Basic → Regular → **$6/月**（1 vCPU、1GB RAM、25GB SSD）
   - **認証：** SSH キー（推奨）またはパスワード
4. **Create Droplet** をクリック
5. IP アドレスをメモ

## 2) SSH で接続する

```bash
ssh root@YOUR_DROPLET_IP
```

## 3) OpenClaw をインストールする

```bash
# システムを更新
apt update && apt upgrade -y

# Node.js 22 をインストール
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# OpenClaw をインストール
curl -fsSL https://openclaw.ai/install.sh | bash

# 確認
openclaw --version
```

## 4) オンボーディングを実行する

```bash
openclaw onboard --install-daemon
```

ウィザードが以下を案内します：

- モデル認証（API キーまたは OAuth）
- チャンネルセットアップ（Telegram、WhatsApp、Discord など）
- Gateway トークン（自動生成）
- デーモンインストール（systemd）

## 5) Gateway を確認する

```bash
# ステータスを確認
openclaw status

# サービスを確認
systemctl --user status openclaw-gateway.service

# ログを表示
journalctl --user -u openclaw-gateway.service -f
```

## 6) ダッシュボードにアクセスする

Gateway はデフォルトで loopback にバインドされます。Control UI にアクセスするには：

**オプション A：SSH トンネル（推奨）**

```bash
# ローカルマシンから
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# その後開く：http://localhost:18789
```

**オプション B：Tailscale Serve（HTTPS、loopback のみ）**

```bash
# Droplet 上で
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Gateway を Tailscale Serve 用に設定
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

以下を開きます：`https://<magicdns>/`

注意：

- Serve は Gateway を loopback のみに保ち、Tailscale アイデンティティヘッダーを介して Control UI/WebSocket トラフィックを認証します（トークンレス認証は信頼された Gateway ホストを前提とします。HTTP API にはトークン/パスワードが必要です）。
- トークン/パスワードを必須にするには、`gateway.auth.allowTailscale: false` を設定するか、`gateway.auth.mode: "password"` を使用してください。

**オプション C：Tailnet バインド（Serve なし）**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

以下を開きます：`http://<tailscale-ip>:18789`（トークンが必要）。

## 7) チャンネルを接続する

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# QR コードをスキャン
```

他のプロバイダーについては [チャンネル](/channels) を参照してください。

---

## 1GB RAM の最適化

$6 の Droplet は RAM が 1GB しかありません。スムーズに動作させるには：

### Swap を追加する（推奨）

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 軽量なモデルを使用する

OOM（メモリ不足）が発生する場合は、以下を検討してください：

- ローカルモデルの代わりに API ベースのモデル（Claude、GPT）を使用
- `agents.defaults.model.primary` をより小さなモデルに設定

### メモリを監視する

```bash
free -h
htop
```

---

## 永続性

すべての状態は以下に保存されます：

- `~/.openclaw/` -- 設定、クレデンシャル、セッションデータ
- `~/.openclaw/workspace/` -- ワークスペース（SOUL.md、メモリなど）

これらは再起動後も保持されます。定期的にバックアップしてください：

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle Cloud 無料代替案

Oracle Cloud は、ここにあるどの有料オプションよりも大幅に強力な **Always Free** ARM インスタンスを月額 $0 で提供しています。

| 内容 | スペック |
| ----------------- | ---------------------- |
| **4 OCPU**        | ARM Ampere A1          |
| **24GB RAM**      | 十分すぎる容量         |
| **200GB ストレージ** | ブロックボリューム     |
| **永久無料**      | クレジットカード課金なし |

**注意事項：**

- サインアップがうまくいかないことがあります（失敗した場合はリトライしてください）
- ARM アーキテクチャ -- ほとんどのものは動作しますが、一部のバイナリは ARM ビルドが必要です

完全なセットアップガイドについては [Oracle Cloud](/platforms/oracle) を参照してください。サインアップのコツと登録プロセスのトラブルシューティングについては、この[コミュニティガイド](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)を参照してください。

---

## トラブルシューティング

### Gateway が起動しない

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### ポートが既に使用されている

```bash
lsof -i :18789
kill <PID>
```

### メモリ不足

```bash
# メモリを確認
free -h

# Swap を追加
# または $12/月の Droplet（2GB RAM）にアップグレード
```

---

## 関連項目

- [Hetzner ガイド](/install/hetzner) -- より安価で高性能
- [Docker インストール](/install/docker) -- コンテナ化されたセットアップ
- [Tailscale](/gateway/tailscale) -- 安全なリモートアクセス
- [設定](/gateway/configuration) -- 完全な設定リファレンス
