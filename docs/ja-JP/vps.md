---
summary: "OpenClaw の VPS ホスティングハブ（Oracle/Fly/Hetzner/GCP/exe.dev）"
read_when:
  - Gateway をクラウドで実行したい場合
  - VPS/ホスティングガイドのクイックマップが必要な場合
title: "VPS ホスティング"
---

# VPS ホスティング

このハブは、サポートされている VPS/ホスティングガイドへのリンクを提供し、クラウドデプロイメントが高レベルでどのように機能するかを説明します。

## プロバイダーを選ぶ

- **Railway**（ワンクリック + ブラウザセットアップ）: [Railway](/install/railway)
- **Northflank**（ワンクリック + ブラウザセットアップ）: [Northflank](/install/northflank)
- **Oracle Cloud（Always Free）**: [Oracle](/platforms/oracle) — 月額 $0（Always Free、ARM; キャパシティ/サインアップは難しい場合あり）
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner（Docker）**: [Hetzner](/install/hetzner)
- **GCP（Compute Engine）**: [GCP](/install/gcp)
- **exe.dev**（VM + HTTPS プロキシ）: [exe.dev](/install/exe-dev)
- **AWS（EC2/Lightsail/無料ティア）**: こちらも良好に動作します。ビデオガイド: [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## クラウドセットアップの仕組み

- **Gateway は VPS 上で実行**し、状態とワークスペースを所有します。
- ラップトップ/スマートフォンから **Control UI** または **Tailscale/SSH** 経由で接続します。
- VPS を信頼できる情報源として扱い、状態とワークスペースを**バックアップ**してください。
- セキュアなデフォルト: Gateway をループバックに保ち、SSH トンネルまたは Tailscale Serve 経由でアクセスします。`lan`/`tailnet` にバインドする場合は `gateway.auth.token` または `gateway.auth.password` を必須にしてください。

リモートアクセス: [Gateway リモート](/gateway/remote)
プラットフォームハブ: [プラットフォーム](/platforms)

## VPS 上の共有企業エージェント

ユーザーが 1 つのトラスト境界内にいる場合（例: 1 つの会社チーム）で、エージェントがビジネス専用の場合、これは有効なセットアップです。

- 専用のランタイム（VPS/VM/コンテナ + 専用 OS ユーザー/アカウント）上に保持してください。
- そのランタイムを個人の Apple/Google アカウントや個人のブラウザ/パスワードマネージャープロファイルにサインインしないでください。
- ユーザーが互いに敵対している場合は、Gateway/ホスト/OS ユーザーで分割してください。

セキュリティモデルの詳細: [セキュリティ](/gateway/security)

## VPS でノードを使用する

Gateway をクラウドに置き、ローカルデバイス（Mac/iOS/Android/ヘッドレス）に**ノード**をペアリングできます。ノードはローカルのスクリーン/カメラ/キャンバスと `system.run` 機能を提供し、Gateway はクラウドに留まります。

ドキュメント: [ノード](/nodes)、[ノード CLI](/cli/nodes)
