---
read_when:
  - LinuxサーバーやクラウドVPSでGateway ゲートウェイを実行したい場合
  - ホスティングガイドの簡単なマップが必要な場合
  - OpenClaw向けの汎用Linuxサーバーチューニングを知りたい場合
sidebarTitle: Linux Server
summary: LinuxサーバーやクラウドVPSでOpenClawを実行する — プロバイダー選択、アーキテクチャ、チューニング
title: Linuxサーバー
x-i18n:
  generated_at: "2026-04-02T08:42:01Z"
  model: claude-opus-4-6
  provider: anthropic
  source_hash: 8e1085ef3eec2f947bffde9ac1ffc92c2925f836df0c07e1568ea11d046a8ca8
  source_path: vps.md
  workflow: 15
---

# Linuxサーバー

任意のLinuxサーバーやクラウドVPSでOpenClaw Gateway ゲートウェイを実行します。このページでは、プロバイダーの選択方法、クラウドデプロイの仕組み、あらゆる環境に適用できる汎用Linuxチューニングについて説明します。

## プロバイダーを選択する

<CardGroup cols={2}>
  <Card title="Railway" href="/ja-JP/install/railway">ワンクリック、ブラウザでセットアップ</Card>
  <Card title="Northflank" href="/ja-JP/install/northflank">ワンクリック、ブラウザでセットアップ</Card>
  <Card title="DigitalOcean" href="/ja-JP/install/digitalocean">シンプルな有料VPS</Card>
  <Card title="Oracle Cloud" href="/ja-JP/install/oracle">Always Free ARMティア</Card>
  <Card title="Fly.io" href="/ja-JP/install/fly">Fly Machines</Card>
  <Card title="Hetzner" href="/ja-JP/install/hetzner">Hetzner VPS上のDocker</Card>
  <Card title="GCP" href="/ja-JP/install/gcp">Compute Engine</Card>
  <Card title="Azure" href="/ja-JP/install/azure">Linux VM</Card>
  <Card title="exe.dev" href="/ja-JP/install/exe-dev">HTTPSプロキシ付きVM</Card>
  <Card title="Raspberry Pi" href="/ja-JP/install/raspberry-pi">ARMセルフホスト</Card>
</CardGroup>

**AWS（EC2 / Lightsail / 無料枠）**も問題なく動作します。
コミュニティによるビデオウォークスルーが
[x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)
で公開されています（コミュニティリソース -- 利用できなくなる場合があります）。

## クラウドセットアップの仕組み

- **Gateway ゲートウェイはVPS上で実行**され、状態とワークスペースを管理します。
- ノートパソコンやスマートフォンから**コントロールUI**または**Tailscale/SSH**経由で接続します。
- VPSを信頼できる情報源として扱い、状態とワークスペースを定期的に**バックアップ**してください。
- セキュアなデフォルト: Gateway ゲートウェイをloopbackで維持し、SSHトンネルまたはTailscale Serve経由でアクセスします。
  `lan`や`tailnet`にバインドする場合は、`gateway.auth.token`または`gateway.auth.password`を要求してください。

関連ページ: [Gateway ゲートウェイ リモートアクセス](/ja-JP/gateway/remote)、[プラットフォームハブ](/ja-JP/platforms)。

## VPS上の共有チームエージェント

チーム全体で単一のエージェントを実行することは、すべてのユーザーが同じ信頼境界にあり、エージェントがビジネス専用である場合に有効なセットアップです。

- 専用ランタイム（VPS/VM/コンテナ＋専用OSユーザー/アカウント）で実行してください。
- そのランタイムに個人のApple/Googleアカウントや、個人のブラウザ/パスワードマネージャープロファイルでサインインしないでください。
- ユーザー同士が互いに信頼できない場合は、Gateway ゲートウェイ/ホスト/OSユーザーで分離してください。

セキュリティモデルの詳細: [セキュリティ](/ja-JP/gateway/security)。

## VPSでのノードの使用

Gateway ゲートウェイをクラウドに置いたまま、ローカルデバイス（Mac/iOS/Android/ヘッドレス）に**ノード**をペアリングできます。ノードはローカルの画面/カメラ/キャンバスと`system.run`機能を提供し、Gateway ゲートウェイはクラウドに留まります。

ドキュメント: [ノード](/ja-JP/nodes)、[ノードCLI](/ja-JP/cli/nodes)。

## 小規模VMおよびARMホスト向けの起動チューニング

低スペックVM（またはARMホスト）でCLIコマンドが遅く感じる場合は、Nodeのモジュールコンパイルキャッシュを有効にしてください:

```bash
grep -q 'NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache' ~/.bashrc || cat >> ~/.bashrc <<'EOF'
export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
mkdir -p /var/tmp/openclaw-compile-cache
export OPENCLAW_NO_RESPAWN=1
EOF
source ~/.bashrc
```

- `NODE_COMPILE_CACHE`はコマンドの繰り返し起動時間を改善します。
- `OPENCLAW_NO_RESPAWN=1`は自己リスポーンパスによる追加の起動オーバーヘッドを回避します。
- 最初のコマンド実行でキャッシュがウォームアップされ、以降の実行が高速になります。
- Raspberry Pi固有の情報については、[Raspberry Pi](/ja-JP/install/raspberry-pi)を参照してください。

### systemdチューニングチェックリスト（オプション）

`systemd`を使用するVMホストでは、以下を検討してください:

- 安定した起動パスのためにサービス環境変数を追加:
  - `OPENCLAW_NO_RESPAWN=1`
  - `NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache`
- リスタート動作を明示的に設定:
  - `Restart=always`
  - `RestartSec=2`
  - `TimeoutStartSec=90`
- ランダムI/Oのコールドスタートペナルティを軽減するために、状態/キャッシュパスにはSSDバックのディスクを推奨します。

例:

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

`Restart=`ポリシーによる自動復旧の仕組み:
[systemdによるサービス復旧の自動化](https://www.redhat.com/en/blog/systemd-automate-recovery)。
