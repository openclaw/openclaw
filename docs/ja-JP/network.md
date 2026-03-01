---
summary: "ネットワークハブ: Gateway サーフェス、ペアリング、発見、セキュリティ"
read_when:
  - ネットワークアーキテクチャ + セキュリティの概要が必要な場合
  - ローカル vs テイルネットアクセスやペアリングをデバッグする場合
  - ネットワークドキュメントの正規リストが必要な場合
title: "ネットワーク"
---

# ネットワークハブ

このハブは、OpenClaw がデバイス間でどのように接続、ペアリング、セキュリティを確保するかについてのコアドキュメントをリンクしています（localhost、LAN、テイルネット）。

## コアモデル

- [Gateway アーキテクチャ](/concepts/architecture)
- [Gateway プロトコル](/gateway/protocol)
- [Gateway ランブック](/gateway)
- [Web サーフェス + バインドモード](/web)

## ペアリング + アイデンティティ

- [ペアリングの概要（DM + ノード）](/channels/pairing)
- [Gateway 所有のノードペアリング](/gateway/pairing)
- [デバイス CLI（ペアリング + トークンローテーション）](/cli/devices)
- [ペアリング CLI（DM 承認）](/cli/pairing)

ローカルトラスト:

- ローカル接続（ループバックまたは Gateway ホスト自身のテイルネットアドレス）は、同一ホストの UX をスムーズに保つためにペアリングを自動承認できます。
- 非ローカルのテイルネット/LAN クライアントは依然として明示的なペアリング承認が必要です。

## 発見 + トランスポート

- [発見 & トランスポート](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [リモートアクセス（SSH）](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## ノード + トランスポート

- [ノードの概要](/nodes)
- [Bridge プロトコル（レガシーノード）](/gateway/bridge-protocol)
- [ノードランブック: iOS](/platforms/ios)
- [ノードランブック: Android](/platforms/android)

## セキュリティ

- [セキュリティの概要](/gateway/security)
- [Gateway コンフィグリファレンス](/gateway/configuration)
- [トラブルシューティング](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
