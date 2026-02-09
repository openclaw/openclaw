---
summary: "OpenClaw 向けの VPS ホスティングハブ（Oracle/Fly/Hetzner/GCP/exe.dev）"
read_when:
  - クラウドで Gateway（ゲートウェイ）を実行したい場合
  - VPS/ホスティングのガイドを手早く把握したい場合
title: "VPS ホスティング"
---

# VPS ホスティング

このハブでは、サポートされている VPS/ホスティングのガイドへのリンクと、クラウド
デプロイメントの仕組みを高いレベルで説明します。

## プロバイダーを選ぶ

- **Railway**（ワンクリック + ブラウザー設定）: [Railway](/install/railway)
- **Northflank**（ワンクリック + ブラウザー設定）: [Northflank](/install/northflank)
- **Oracle Cloud（Always Free）**: [Oracle](/platforms/oracle) — 月額 $0（Always Free、ARM。容量やサインアップが不安定な場合があります）
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner（Docker）**: [Hetzner](/install/hetzner)
- **GCP（Compute Engine）**: [GCP](/install/gcp)
- **exe.dev**（VM + HTTPS プロキシ）: [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/free tier)**: うまく動作します。 ビデオガイド:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## クラウド構成の仕組み

- **Gateway（ゲートウェイ）は VPS 上で実行**され、状態とワークスペースを管理します。
- ノート PC/スマートフォンから **Control UI** または **Tailscale/SSH** 経由で接続します。
- VPS を信頼できる唯一の情報源として扱い、状態とワークスペースを **バックアップ** してください。
- セキュアな既定値: Gateway を loopback のままにし、SSH トンネルまたは Tailscale Serve 経由でアクセスします。
  `lan`/`tailnet` にバインドする場合は、`gateway.auth.token` または `gateway.auth.password` を必須にしてください。
  `lan`/`tailnet` にバインドする場合は、 `gateway.auth.token` または `gateway.auth.password` が必要です。

リモートアクセス: [Gateway remote](/gateway/remote)  
プラットフォーム ハブ: [Platforms](/platforms)

## VPS でノードを使う

Gateway をクラウドに置いたまま、ローカル デバイス
（Mac/iOS/Android/ヘッドレス）上の **ノード** とペアリングできます。ノードはローカルの画面/カメラ/キャンバスおよび `system.run`
の機能を提供し、Gateway はクラウドに留まります。 ノードは、ゲートウェイがクラウドにとどまる間、ローカルのスクリーン/カメラ/キャンバスと `system.run`
機能を提供します。

ドキュメント: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
