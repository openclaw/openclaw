---
read_when:
  - クラウドでGatewayを運用したいとき
  - VPS/ホスティングガイドの概要を知りたいとき
summary: "OpenClawのVPSホスティングハブ（Oracle/Fly/Hetzner/GCP/exe.dev）"
title: "VPSホスティング"
x-i18n:
  generated_at: "2026-03-04T04:14:00Z"
  model: claude-opus-4-6
  provider: pi
  source_hash: ""
  source_path: vps.md
  workflow: 15
---

# VPSホスティング

このハブでは、サポートされているVPS/ホスティングガイドへのリンクと、クラウドデプロイメントの概要を説明します。

## プロバイダーを選ぶ

- **Railway**（ワンクリック＋ブラウザセットアップ）: [Railway](/install/railway)
- **Northflank**（ワンクリック＋ブラウザセットアップ）: [Northflank](/install/northflank)
- **Oracle Cloud（Always Free）**: [Oracle](/platforms/oracle) — 月額$0（Always Free、ARM。容量やサインアップが不安定な場合あり）
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner（Docker）**: [Hetzner](/install/hetzner)
- **GCP（Compute Engine）**: [GCP](/install/gcp)
- **exe.dev**（VM＋HTTPSプロキシ）: [exe.dev](/install/exe-dev)
- **AWS（EC2/Lightsail/無料枠）**: こちらも問題なく動作します。動画ガイド：
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## クラウドセットアップの仕組み

- **GatewayはVPS上で動作**し、ステートとワークスペースを管理します。
- ノートPCやスマートフォンから**Control UI**や**Tailscale/SSH**経由で接続します。
- VPSを信頼できる情報源として扱い、ステートとワークスペースを**バックアップ**してください。
- セキュアなデフォルト設定：Gatewayをループバックで動作させ、SSHトンネルまたはTailscale Serve経由でアクセスします。
  `lan`/`tailnet`にバインドする場合は、`gateway.auth.token`または`gateway.auth.password`を設定してください。

リモートアクセス: [Gatewayリモート](/gateway/remote)
プラットフォームハブ: [プラットフォーム](/platforms)

## VPS上の共有カンパニーエージェント

ユーザーが同一の信頼境界内にいる場合（例：社内チーム）、エージェントがビジネス専用であれば、これは有効なセットアップです。

- 専用のランタイム（VPS/VM/コンテナ＋専用OSユーザー/アカウント）で運用してください。
- そのランタイムに個人のApple/Googleアカウントや個人のブラウザ/パスワードマネージャーのプロファイルでサインインしないでください。
- ユーザー同士が敵対的な場合は、Gateway/ホスト/OSユーザーごとに分離してください。

セキュリティモデルの詳細: [セキュリティ](/gateway/security)

## VPSでのノードの使用

Gatewayをクラウドに配置したまま、ローカルデバイス（Mac/iOS/Android/ヘッドレス）に**ノード**をペアリングできます。ノードはローカルの画面/カメラ/キャンバスおよび`system.run`機能を提供し、Gatewayはクラウドに留まります。

ドキュメント: [ノード](/nodes)、[ノードCLI](/cli/nodes)

## 小規模VMおよびARMホスト向けの起動チューニング

低スペックのVM（またはARMホスト）でCLIコマンドが遅く感じる場合は、Nodeのモジュールコンパイルキャッシュを有効にしてください：

```bash
grep -q 'NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache' ~/.bashrc || cat >> ~/.bashrc <<'EOF'
export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
mkdir -p /var/tmp/openclaw-compile-cache
export OPENCLAW_NO_RESPAWN=1
EOF
source ~/.bashrc
```

- `NODE_COMPILE_CACHE`は繰り返しのコマンド起動時間を改善します。
- `OPENCLAW_NO_RESPAWN=1`はセルフリスポーンパスによる追加の起動オーバーヘッドを回避します。
- 最初のコマンド実行でキャッシュがウォームアップされ、以降の実行が高速になります。
- Raspberry Pi固有の情報については、[Raspberry Pi](/platforms/raspberry-pi)を参照してください。

### systemdチューニングチェックリスト（オプション）

`systemd`を使用するVMホストでは、以下を検討してください：

- 安定した起動パスのためにサービス環境変数を追加：
  - `OPENCLAW_NO_RESPAWN=1`
  - `NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache`
- リスタート動作を明示的に設定：
  - `Restart=always`
  - `RestartSec=2`
  - `TimeoutStartSec=90`
- ランダムI/Oのコールドスタートペナルティを軽減するため、ステート/キャッシュパスにはSSD搭載ディスクを推奨します。

例：

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

`Restart=`ポリシーによる自動復旧の仕組み：
[systemdによるサービス復旧の自動化](https://www.redhat.com/en/blog/systemd-automate-recovery)。
