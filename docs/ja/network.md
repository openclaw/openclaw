---
summary: "ネットワークハブ：ゲートウェイのサーフェス、ペアリング、検出、セキュリティ"
read_when:
  - ネットワークアーキテクチャとセキュリティの概要が必要な場合
  - ローカルアクセスと tailnet アクセス、またはペアリングの問題をデバッグしている場合
  - ネットワーキング関連ドキュメントの正規一覧を確認したい場合
title: "ネットワーク"
---

# Network hub

このハブは、OpenClaw が localhost、LAN、tailnet 全体でデバイスを接続、ペアリング、保護する方法に関する中核ドキュメントへのリンクをまとめたものです。

## Core model

- [Gateway アーキテクチャ](/concepts/architecture)
- [Gateway プロトコル](/gateway/protocol)
- [Gateway ランブック](/gateway)
- [Web サーフェスとバインドモード](/web)

## Pairing + identity

- [ペアリング概要（DM + ノード）](/channels/pairing)
- [Gateway 所有ノードのペアリング](/gateway/pairing)
- [Devices CLI（ペアリング + トークンローテーション）](/cli/devices)
- [Pairing CLI（DM 承認）](/cli/pairing)

ローカルの信頼：

- ローカル接続（loopback または ゲートウェイ ホスト 自身の tailnet アドレス）は、同一ホストでの UX を円滑に保つため、ペアリングが自動承認される場合があります。
- 非ローカルの tailnet/LAN クライアントでは、引き続き明示的なペアリング承認が必要です。

## Discovery + transports

- [検出とトランスポート](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [リモートアクセス（SSH）](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## Nodes + transports

- [ノード概要](/nodes)
- [ブリッジプロトコル（レガシーノード）](/gateway/bridge-protocol)
- [ノード ランブック：iOS](/platforms/ios)
- [ノード ランブック：Android](/platforms/android)

## Security

- [セキュリティ概要](/gateway/security)
- [Gateway 設定リファレンス](/gateway/configuration)
- [トラブルシューティング](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
