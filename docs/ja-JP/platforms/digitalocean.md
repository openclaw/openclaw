---
read_when:
    - DigitalOceanでOpenClawをセットアップする場合
    - OpenClaw用の安価なVPSホスティングを探している場合
summary: DigitalOceanでのOpenClaw（シンプルな有料VPSオプション）
title: DigitalOcean（プラットフォーム）
x-i18n:
    generated_at: "2026-04-02T07:47:22Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: b00819ea58c52e10afe99199fae0a999a114ce1a2b853e26f2f0aabcaa540315
    source_path: platforms/digitalocean.md
    workflow: 15
---

# DigitalOceanでOpenClawを使う

## 目標

DigitalOcean上で永続的なOpenClaw Gateway ゲートウェイを**月額$6**（リザーブド料金で月額$4）で稼働させます。

月額$0のオプションが必要で、ARM + プロバイダー固有のセットアップが問題ない場合は、[Oracle Cloudガイド](/platforms/oracle)を参照してください。

## コスト比較（2026年）

| プロバイダー | プラン          | スペック                 | 月額料金      | 備考                                  |
| ------------ | --------------- | ---------------------- | ----------- | ------------------------------------- |
| Oracle Cloud | Always Free ARM | 最大4 OCPU、24GB RAM    | $0          | ARM、容量制限 / サインアップに癖あり     |
| Hetzner      | CX22            | 2 vCPU、4GB RAM         | €3.79（約$4）| 最安の有料オプション                    |
| DigitalOcean | Basic           | 1 vCPU、1GB RAM         | $6          | 簡単なUI、充実したドキュメント           |
| Vultr        | Cloud Compute   | 1 vCPU、1GB RAM         | $6          | ロケーション多数                        |
| Linode       | Nanode          | 1 vCPU、1GB RAM         | $5          | 現在Akamaiの一部                       |

**プロバイダーの選び方:**

- DigitalOcean: 最もシンプルなUX + 予測可能なセットアップ（本ガイド）
- Hetzner: 価格性能比が良い（[Hetznerガイド](/install/hetzner)を参照）
- Oracle Cloud: 月額$0も可能だが、やや癖がありARMのみ（[Oracleガイド](/platforms/oracle)を参照）

---

## 前提条件

- DigitalOceanアカウント（[$200の無料クレジット付きサインアップ](https://m.do.co/c/signup)）
- SSHキーペア（またはパスワード認証でも可）
- 約20分

## 1) Dropletの作成

<Warning>
クリーンなベースイメージ（Ubuntu 24.04 LTS）を使用してください。スタートアップスクリプトやファイアウォールのデフォルト設定を確認していない限り、サードパーティのMarketplaceワンクリックイメージは避けてください。
</Warning>

1. [DigitalOcean](https://cloud.digitalocean.com/)にログイン
2. **Create → Droplets** をクリック
3. 以下を選択:
   - **Region:** 自分（またはユーザー）に最も近い場所
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **$6/mo**（1 vCPU、1GB RAM、25GB SSD）
   - **Authentication:** SSHキー（推奨）またはパスワード
4. **Create Droplet** をクリック
5. IPアドレスをメモ

## 2) SSH経由で接続

```bash
ssh root@YOUR_DROPLET_IP
```

## 3) OpenClawのインストール

```bash
# システムの更新
apt update && apt upgrade -y

# Node.js 24のインストール
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs

# OpenClawのインストール
curl -fsSL https://openclaw.ai/install.sh | bash

# 確認
openclaw --version
```

## 4) オンボーディングの実行

```bash
openclaw onboard --install-daemon
```

ウィザードが以下の手順を案内します:

- モデル認証（APIキーまたはOAuth）
- チャネルセットアップ（Telegram、WhatsApp、Discordなど）
- Gateway ゲートウェイトークン（自動生成）
- デーモンのインストール（systemd）

## 5) Gateway ゲートウェイの確認

```bash
# ステータスの確認
openclaw status

# サービスの確認
systemctl --user status openclaw-gateway.service

# ログの表示
journalctl --user -u openclaw-gateway.service -f
```

## 6) ダッシュボードへのアクセス

Gateway ゲートウェイはデフォルトでloopbackにバインドされます。Control UIにアクセスするには:

**オプションA: SSHトンネル（推奨）**

```bash
# ローカルマシンから
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# 次にブラウザで開く: http://localhost:18789
```

**オプションB: Tailscale Serve（HTTPS、loopbackのみ）**

```bash
# Droplet上で
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Tailscale Serveを使用するようGateway ゲートウェイを設定
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

ブラウザで開く: `https://<magicdns>/`

注意事項:

- ServeはGateway ゲートウェイをloopbackのみに保ち、Tailscale IDヘッダーを介してControl UI/WebSocketトラフィックを認証します（トークンレス認証は信頼されたGateway ゲートウェイホストを前提とします。HTTP APIには引き続きトークン/パスワードが必要です）。
- トークン/パスワードを要求するには、`gateway.auth.allowTailscale: false` を設定するか、`gateway.auth.mode: "password"` を使用してください。

**オプションC: Tailnetバインド（Serveなし）**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

ブラウザで開く: `http://<tailscale-ip>:18789`（トークンが必要）。

## 7) チャネルの接続

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# QRコードをスキャン
```

その他のプロバイダーについては[チャネル](/channels)を参照してください。

---

## 1GB RAMの最適化

$6のDropletはRAMが1GBしかありません。スムーズに動作させるために:

### スワップの追加（推奨）

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 軽量モデルの使用

OOMが発生する場合は、以下を検討してください:

- ローカルモデルの代わりにAPIベースのモデル（Claude、GPT）を使用する
- `agents.defaults.model.primary` をより小さなモデルに設定する

### メモリの監視

```bash
free -h
htop
```

---

## データの永続化

すべての状態は以下に保存されます:

- `~/.openclaw/` — 設定、認証情報、セッションデータ
- `~/.openclaw/workspace/` — ワークスペース（SOUL.md、メモリなど）

これらは再起動後も維持されます。定期的にバックアップしてください:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle Cloud無料代替プラン

Oracle Cloudは、ここに挙げたどの有料オプションよりも大幅に強力な**Always Free** ARMインスタンスを月額$0で提供しています。

| 内容              | スペック                |
| ----------------- | ---------------------- |
| **4 OCPU**        | ARM Ampere A1          |
| **24GB RAM**      | 十分すぎる容量          |
| **200GBストレージ** | ブロックボリューム      |
| **永久無料**       | クレジットカード課金なし |

**注意点:**

- サインアップに癖がある（失敗した場合はリトライ）
- ARMアーキテクチャ — ほとんどのものは動作するが、一部のバイナリにはARMビルドが必要

完全なセットアップガイドは[Oracle Cloud](/platforms/oracle)を参照してください。サインアップのコツと登録プロセスのトラブルシューティングについては、この[コミュニティガイド](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)を参照してください。

---

## トラブルシューティング

### Gateway ゲートウェイが起動しない

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### ポートが使用中

```bash
lsof -i :18789
kill <PID>
```

### メモリ不足

```bash
# メモリの確認
free -h

# スワップを追加
# または$12/moのDroplet（2GB RAM）にアップグレード
```

---

## 関連項目

- [Hetznerガイド](/install/hetzner) — より安価で高性能
- [Dockerインストール](/install/docker) — コンテナ化セットアップ
- [Tailscale](/gateway/tailscale) — セキュアなリモートアクセス
- [設定](/gateway/configuration) — 完全な設定リファレンス
