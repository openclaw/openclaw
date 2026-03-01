---
summary: "Oracle Cloud（Always Free ARM）での OpenClaw"
read_when:
  - Oracle Cloud で OpenClaw をセットアップする
  - OpenClaw 向けの低コスト VPS ホスティングを探している
  - 小規模サーバーで 24 時間 365 日の OpenClaw が欲しい
title: "Oracle Cloud"
---

# Oracle Cloud (OCI) での OpenClaw

## 目標

Oracle Cloud の **Always Free** ARM ティアで持続的な OpenClaw Gateway を実行します。

Oracle の無料ティアは OpenClaw に最適です（特に既に OCI アカウントをお持ちの場合）が、トレードオフがあります：

- ARM アーキテクチャ（ほとんどのものは動作しますが、一部のバイナリは x86 専用の場合があります）
- キャパシティとサインアップがうまくいかないことがあります

## コスト比較（2026年）

| プロバイダー | プラン | スペック | 月額 | 備考 |
| ------------ | --------------- | ---------------------- | -------- | --------------------- |
| Oracle Cloud | Always Free ARM | 最大 4 OCPU、24GB RAM | $0       | ARM、容量制限あり |
| Hetzner      | CX22            | 2 vCPU、4GB RAM        | ~ $4     | 最安の有料オプション  |
| DigitalOcean | Basic           | 1 vCPU、1GB RAM        | $6       | 簡単な UI、良いドキュメント |
| Vultr        | Cloud Compute   | 1 vCPU、1GB RAM        | $6       | 多くのロケーション    |
| Linode       | Nanode          | 1 vCPU、1GB RAM        | $5       | 現在 Akamai の一部    |

---

## 前提条件

- Oracle Cloud アカウント（[サインアップ](https://www.oracle.com/cloud/free/)）-- 問題が発生した場合は[コミュニティサインアップガイド](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)を参照
- Tailscale アカウント（[tailscale.com](https://tailscale.com) で無料）
- 約 30 分

## 1) OCI インスタンスを作成する

1. [Oracle Cloud Console](https://cloud.oracle.com/) にログイン
2. **Compute → Instances → Create Instance** に移動
3. 設定：
   - **名前：** `openclaw`
   - **イメージ：** Ubuntu 24.04 (aarch64)
   - **シェイプ：** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPU：** 2（最大 4）
   - **メモリ：** 12 GB（最大 24 GB）
   - **ブートボリューム：** 50 GB（最大 200 GB 無料）
   - **SSH キー：** 公開鍵を追加
4. **Create** をクリック
5. パブリック IP アドレスをメモ

**ヒント：** インスタンスの作成が「Out of capacity」で失敗した場合は、別のアベイラビリティドメインを試すか、後でリトライしてください。無料ティアのキャパシティは限られています。

## 2) 接続してアップデートする

```bash
# パブリック IP で接続
ssh ubuntu@YOUR_PUBLIC_IP

# システムを更新
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**注意：** `build-essential` は一部の依存関係の ARM コンパイルに必要です。

## 3) ユーザーとホスト名を設定する

```bash
# ホスト名を設定
sudo hostnamectl set-hostname openclaw

# ubuntu ユーザーのパスワードを設定
sudo passwd ubuntu

# リンガリングを有効にする（ログアウト後もユーザーサービスを実行し続ける）
sudo loginctl enable-linger ubuntu
```

## 4) Tailscale をインストールする

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

これにより Tailscale SSH が有効になるため、tailnet 上の任意のデバイスから `ssh openclaw` で接続できます -- パブリック IP は不要です。

確認：

```bash
tailscale status
```

**ここからは Tailscale 経由で接続してください：** `ssh ubuntu@openclaw`（または Tailscale IP を使用）。

## 5) OpenClaw をインストールする

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

「How do you want to hatch your bot?」と表示されたら、**「Do this later」** を選択してください。

> 注意：ARM ネイティブのビルドの問題が発生した場合は、Homebrew に頼る前にシステムパッケージ（例：`sudo apt install -y build-essential`）から始めてください。

## 6) Gateway を設定する（loopback + トークン認証）と Tailscale Serve を有効にする

デフォルトとしてトークン認証を使用します。予測可能で、「insecure auth」の Control UI フラグが不要です。

```bash
# Gateway を VM 上でプライベートに保つ
openclaw config set gateway.bind loopback

# Gateway + Control UI に認証を要求
openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# Tailscale Serve 経由で公開（HTTPS + tailnet アクセス）
openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway
```

## 7) 確認する

```bash
# バージョンを確認
openclaw --version

# デーモンステータスを確認
systemctl --user status openclaw-gateway

# Tailscale Serve を確認
tailscale serve status

# ローカルレスポンスをテスト
curl http://localhost:18789
```

## 8) VCN セキュリティをロックダウンする

すべてが動作していることを確認したら、VCN をロックダウンして Tailscale 以外のすべてのトラフィックをブロックします。OCI の Virtual Cloud Network はネットワークエッジでファイアウォールとして機能し、トラフィックがインスタンスに到達する前にブロックされます。

1. OCI Console で **Networking → Virtual Cloud Networks** に移動
2. VCN をクリック → **Security Lists** → Default Security List
3. 以下を除くすべてのイングレスルールを**削除**：
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. デフォルトのイグレスルールを維持（すべてのアウトバウンドを許可）

これにより、ネットワークエッジでポート 22 の SSH、HTTP、HTTPS、その他すべてがブロックされます。以降は Tailscale 経由でのみ接続できます。

---

## Control UI にアクセスする

Tailscale ネットワーク上の任意のデバイスから：

```
https://openclaw.<tailnet-name>.ts.net/
```

`<tailnet-name>` を実際の tailnet 名に置き換えてください（`tailscale status` で確認できます）。

SSH トンネルは不要です。Tailscale が以下を提供します：

- HTTPS 暗号化（自動証明書）
- Tailscale アイデンティティによる認証
- tailnet 上の任意のデバイス（ラップトップ、スマートフォンなど）からのアクセス

---

## セキュリティ：VCN + Tailscale（推奨ベースライン）

VCN をロックダウンし（UDP 41641 のみオープン）、Gateway を loopback にバインドすることで、強力な多層防御が実現されます。パブリックトラフィックはネットワークエッジでブロックされ、管理アクセスは tailnet 経由で行われます。

このセットアップにより、インターネット全体からの SSH ブルートフォースを止めるためだけの追加のホストベースファイアウォールルールが_不要_になることが多いですが、OS の更新を継続し、`openclaw security audit` を実行し、パブリックインターフェースで誤ってリッスンしていないことを確認する必要があります。

### 既に保護されているもの

| 従来のステップ | 必要？ | 理由 |
| ------------------ | ----------- | ---------------------------------------------------------------------------- |
| UFW ファイアウォール | いいえ | VCN がトラフィックをインスタンスに到達する前にブロック |
| fail2ban           | いいえ | VCN でポート 22 がブロックされていればブルートフォースなし |
| sshd ハードニング | いいえ | Tailscale SSH は sshd を使用しない |
| root ログイン無効化 | いいえ | Tailscale はシステムユーザーではなく Tailscale アイデンティティを使用 |
| SSH キーのみ認証 | いいえ | Tailscale は tailnet 経由で認証 |
| IPv6 ハードニング | 通常不要 | VCN/サブネットの設定に依存。実際に割り当て/公開されているものを確認してください |

### 引き続き推奨

- **クレデンシャルのパーミッション：** `chmod 700 ~/.openclaw`
- **セキュリティ監査：** `openclaw security audit`
- **システム更新：** `sudo apt update && sudo apt upgrade` を定期的に実行
- **Tailscale の監視：** [Tailscale 管理コンソール](https://login.tailscale.com/admin)でデバイスを確認

### セキュリティ態勢を確認する

```bash
# パブリックポートがリッスンしていないことを確認
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Tailscale SSH がアクティブであることを確認
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# オプション：sshd を完全に無効化
sudo systemctl disable --now ssh
```

---

## フォールバック：SSH トンネル

Tailscale Serve が動作しない場合は、SSH トンネルを使用してください：

```bash
# ローカルマシンから（Tailscale 経由）
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

その後 `http://localhost:18789` を開きます。

---

## トラブルシューティング

### インスタンスの作成に失敗する（「Out of capacity」）

無料ティアの ARM インスタンスは人気があります。以下を試してください：

- 別のアベイラビリティドメイン
- オフピーク時間（早朝）にリトライ
- シェイプ選択時に「Always Free」フィルターを使用

### Tailscale が接続できない

```bash
# ステータスを確認
sudo tailscale status

# 再認証
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway が起動しない

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### Control UI に到達できない

```bash
# Tailscale Serve が実行中か確認
tailscale serve status

# Gateway がリッスンしているか確認
curl http://localhost:18789

# 必要に応じて再起動
systemctl --user restart openclaw-gateway
```

### ARM バイナリの問題

一部のツールには ARM ビルドがない場合があります。確認：

```bash
uname -m  # aarch64 と表示されるはず
```

ほとんどの npm パッケージは問題なく動作します。バイナリについては、`linux-arm64` または `aarch64` リリースを探してください。

---

## 永続性

すべての状態は以下に保存されます：

- `~/.openclaw/` -- 設定、クレデンシャル、セッションデータ
- `~/.openclaw/workspace/` -- ワークスペース（SOUL.md、メモリ、アーティファクト）

定期的にバックアップしてください：

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## 関連項目

- [Gateway リモートアクセス](/gateway/remote) -- 他のリモートアクセスパターン
- [Tailscale 統合](/gateway/tailscale) -- 完全な Tailscale ドキュメント
- [Gateway 設定](/gateway/configuration) -- すべての設定オプション
- [DigitalOcean ガイド](/platforms/digitalocean) -- 有料でサインアップが簡単な場合
- [Hetzner ガイド](/install/hetzner) -- Docker ベースの代替案
