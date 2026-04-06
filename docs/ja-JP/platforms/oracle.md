---
read_when:
    - Oracle CloudでOpenClawをセットアップする場合
    - OpenClaw向けの低コストVPSホスティングを探している場合
    - 小規模サーバーでOpenClawを24時間365日稼働させたい場合
summary: Oracle Cloud（Always Free ARM）でのOpenClaw
title: Oracle Cloud（プラットフォーム）
x-i18n:
    generated_at: "2026-04-02T08:35:24Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 0f2ebee109d466de6b91293844620c56b775976f009225254a7ad364511f3e28
    source_path: platforms/oracle.md
    workflow: 15
---

# Oracle Cloud（OCI）でのOpenClaw

## 目標

Oracle Cloudの**Always Free** ARMティアで永続的なOpenClaw Gateway ゲートウェイを実行します。

Oracleの無料ティアはOpenClawに適しています（特にすでにOCIアカウントをお持ちの場合）が、トレードオフがあります：

- ARMアーキテクチャ（ほとんどのものは動作しますが、一部のバイナリはx86専用の場合があります）
- キャパシティとサインアップが不安定な場合があります

## コスト比較（2026年）

| プロバイダー | プラン | スペック | 月額料金 | 備考 |
| ------------ | --------------- | ---------------------- | -------- | --------------------- |
| Oracle Cloud | Always Free ARM | 最大4 OCPU、24GB RAM | $0 | ARM、キャパシティ制限あり |
| Hetzner | CX22 | 2 vCPU、4GB RAM | 約 $4 | 最安の有料オプション |
| DigitalOcean | Basic | 1 vCPU、1GB RAM | $6 | 簡単なUI、充実したドキュメント |
| Vultr | Cloud Compute | 1 vCPU、1GB RAM | $6 | 多数のロケーション |
| Linode | Nanode | 1 vCPU、1GB RAM | $5 | 現在Akamaiの一部 |

---

## 前提条件

- Oracle Cloudアカウント（[サインアップ](https://www.oracle.com/cloud/free/)）— 問題が発生した場合は[コミュニティサインアップガイド](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)を参照
- Tailscaleアカウント（[tailscale.com](https://tailscale.com)で無料）
- 約30分

## 1) OCIインスタンスの作成

1. [Oracle Cloud Console](https://cloud.oracle.com/)にログイン
2. **Compute → Instances → Create Instance**に移動
3. 設定：
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2（最大4まで）
   - **Memory:** 12 GB（最大24 GBまで）
   - **Boot volume:** 50 GB（最大200 GBまで無料）
   - **SSH key:** 公開鍵を追加
4. **Create**をクリック
5. パブリックIPアドレスをメモ

**ヒント:** インスタンス作成が「Out of capacity」で失敗した場合は、別のアベイラビリティドメインを試すか、後で再試行してください。無料ティアのキャパシティには制限があります。

## 2) 接続とアップデート

```bash
# パブリックIP経由で接続
ssh ubuntu@YOUR_PUBLIC_IP

# システムのアップデート
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**注意:** `build-essential`は一部の依存関係のARMコンパイルに必要です。

## 3) ユーザーとホスト名の設定

```bash
# ホスト名の設定
sudo hostnamectl set-hostname openclaw

# ubuntuユーザーのパスワード設定
sudo passwd ubuntu

# リンガリングの有効化（ログアウト後もユーザーサービスを維持）
sudo loginctl enable-linger ubuntu
```

## 4) Tailscaleのインストール

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

これによりTailscale SSHが有効になり、tailnet上の任意のデバイスから`ssh openclaw`で接続できます — パブリックIPは不要です。

確認：

```bash
tailscale status
```

**以降はTailscale経由で接続してください:** `ssh ubuntu@openclaw`（またはTailscale IPを使用）。

## 5) OpenClawのインストール

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

「How do you want to hatch your bot?」と表示されたら、**「Do this later」**を選択してください。

> 注意: ARMネイティブビルドの問題が発生した場合は、Homebrewに頼る前にシステムパッケージ（例: `sudo apt install -y build-essential`）から始めてください。

## 6) Gateway ゲートウェイの設定（loopback + トークン認証）とTailscale Serveの有効化

デフォルトとしてトークン認証を使用します。予測可能で、コントロールUIで「insecure auth」フラグを設定する必要がありません。

```bash
# Gateway ゲートウェイをVM上のプライベートに保持
openclaw config set gateway.bind loopback

# Gateway ゲートウェイ + コントロールUIに認証を要求
openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# Tailscale Serve経由で公開（HTTPS + tailnetアクセス）
openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway
```

`gateway.trustedProxies=["127.0.0.1"]`はローカルのTailscale Serveプロキシ用です。Diffビューアールートはこのセットアップではフェイルクローズ動作を維持します: 転送されたプロキシヘッダーなしの生の`127.0.0.1`ビューアーリクエストは`Diff not found`を返す場合があります。添付ファイルには`mode=file` / `mode=both`を使用するか、共有可能なビューアーリンクが必要な場合はリモートビューアーを意図的に有効にして`plugins.entries.diffs.config.viewerBaseUrl`（またはプロキシの`baseUrl`を渡す）を設定してください。

## 7) 確認

```bash
# バージョンの確認
openclaw --version

# デーモンステータスの確認
systemctl --user status openclaw-gateway

# Tailscale Serveの確認
tailscale serve status

# ローカルレスポンスのテスト
curl http://localhost:18789
```

## 8) VCNセキュリティのロックダウン

すべてが動作していることを確認したら、Tailscale以外のすべてのトラフィックをブロックするようにVCNをロックダウンします。OCIのVirtual Cloud Networkはネットワークエッジでファイアウォールとして機能し、トラフィックがインスタンスに到達する前にブロックされます。

1. OCIコンソールで**Networking → Virtual Cloud Networks**に移動
2. VCNをクリック → **Security Lists** → Default Security List
3. 以下を除くすべてのイングレスルールを**削除**：
   - `0.0.0.0/0 UDP 41641`（Tailscale）
4. デフォルトのエグレスルール（すべてのアウトバウンドを許可）は維持

これにより、ポート22のSSH、HTTP、HTTPS、その他すべてがネットワークエッジでブロックされます。以降はTailscale経由でのみ接続できます。

---

## コントロールUIへのアクセス

Tailscaleネットワーク上の任意のデバイスから：

```
https://openclaw.<tailnet-name>.ts.net/
```

`<tailnet-name>`をtailnet名（`tailscale status`で確認可能）に置き換えてください。

SSHトンネルは不要です。Tailscaleが提供するもの：

- HTTPS暗号化（自動証明書）
- Tailscale IDによる認証
- tailnet上の任意のデバイス（ノートPC、スマートフォンなど）からのアクセス

---

## セキュリティ: VCN + Tailscale（推奨ベースライン）

VCNをロックダウン（UDP 41641のみ開放）し、Gateway ゲートウェイをloopbackにバインドすることで、強力な多層防御が実現します: パブリックトラフィックはネットワークエッジでブロックされ、管理アクセスはtailnet経由で行われます。

このセットアップにより、インターネット全体のSSHブルートフォースを防ぐためだけのホストベースのファイアウォールルールが不要になることがよくあります。ただし、OSを最新の状態に保ち、`openclaw security audit`を実行し、パブリックインターフェースで意図せずリッスンしていないことを確認してください。

### すでに保護されている項目

| 従来のステップ | 必要か？ | 理由 |
| ------------------ | ----------- | ---------------------------------------------------------------------------- |
| UFWファイアウォール | 不要 | VCNがトラフィックをインスタンスに到達する前にブロック |
| fail2ban | 不要 | VCNでポート22がブロックされていればブルートフォースなし |
| sshdの強化 | 不要 | Tailscale SSHはsshdを使用しない |
| rootログインの無効化 | 不要 | TailscaleはシステムユーザーではなくTailscale IDを使用 |
| SSH鍵のみの認証 | 不要 | Tailscaleはtailnet経由で認証 |
| IPv6の強化 | 通常不要 | VCN/サブネット設定による; 実際に割り当て/公開されているものを確認 |

### 引き続き推奨される項目

- **認証情報の権限:** `chmod 700 ~/.openclaw`
- **セキュリティ監査:** `openclaw security audit`
- **システムアップデート:** `sudo apt update && sudo apt upgrade`を定期的に実行
- **Tailscaleの監視:** [Tailscale管理コンソール](https://login.tailscale.com/admin)でデバイスを確認

### セキュリティ状態の確認

```bash
# パブリックポートがリッスンしていないことを確認
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Tailscale SSHが有効であることを確認
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# オプション: sshdを完全に無効化
sudo systemctl disable --now ssh
```

---

## フォールバック: SSHトンネル

Tailscale Serveが動作しない場合は、SSHトンネルを使用してください：

```bash
# ローカルマシンから（Tailscale経由）
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

その後、`http://localhost:18789`を開きます。

---

## トラブルシューティング

### インスタンス作成の失敗（「Out of capacity」）

無料ティアのARMインスタンスは人気があります。以下を試してください：

- 別のアベイラビリティドメイン
- オフピーク時間帯（早朝）に再試行
- シェイプ選択時に「Always Free」フィルターを使用

### Tailscaleが接続できない

```bash
# ステータスの確認
sudo tailscale status

# 再認証
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway ゲートウェイが起動しない

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### コントロールUIにアクセスできない

```bash
# Tailscale Serveが実行中であることを確認
tailscale serve status

# Gateway ゲートウェイがリッスンしていることを確認
curl http://localhost:18789

# 必要に応じて再起動
systemctl --user restart openclaw-gateway
```

### ARMバイナリの問題

一部のツールにはARMビルドがない場合があります。確認：

```bash
uname -m  # aarch64と表示されるはず
```

ほとんどのnpmパッケージは問題なく動作します。バイナリについては、`linux-arm64`または`aarch64`のリリースを探してください。

---

## 永続化

すべての状態は以下に保存されます：

- `~/.openclaw/` — 設定、認証情報、セッションデータ
- `~/.openclaw/workspace/` — ワークスペース（SOUL.md、メモリ、アーティファクト）

定期的にバックアップしてください：

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## 関連情報

- [Gateway ゲートウェイリモートアクセス](/gateway/remote) — その他のリモートアクセスパターン
- [Tailscale統合](/gateway/tailscale) — Tailscaleの完全なドキュメント
- [Gateway ゲートウェイ設定](/gateway/configuration) — すべての設定オプション
- [DigitalOceanガイド](/platforms/digitalocean) — 有料で簡単なサインアップが必要な場合
- [Hetznerガイド](/install/hetzner) — Dockerベースの代替手段
