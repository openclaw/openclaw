---
read_when:
    - ネットワークアーキテクチャとセキュリティの概要が必要な場合
    - ローカル vs tailnet アクセスやペアリングのデバッグをしている場合
    - ネットワーク関連ドキュメントの一覧が必要な場合
summary: 'ネットワークハブ: Gateway ゲートウェイのサーフェス、ペアリング、ディスカバリー、セキュリティ'
title: ネットワーク
x-i18n:
    generated_at: "2026-04-02T07:45:47Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: b7a85ebeee9ea6d129083d9415f4b55bf816d29b531cf93f039b55da30948726
    source_path: network.md
    workflow: 15
---

# ネットワークハブ

このハブは、OpenClawが localhost、LAN、tailnet を介してデバイスを接続、ペアリング、保護する方法に関するコアドキュメントをまとめています。

## コアモデル

ほとんどの操作は Gateway ゲートウェイ（`openclaw gateway`）を経由します。これはチャネル接続と WebSocket コントロールプレーンを管理する単一の長時間実行プロセスです。

- **ループバック優先**: Gateway ゲートウェイの WS はデフォルトで `ws://127.0.0.1:18789` です。非ループバックバインドにはトークンが必要です。
- **ホストごとに1つの Gateway ゲートウェイ**が推奨されます。分離が必要な場合は、個別のプロファイルとポートで複数のゲートウェイを実行してください（[複数の Gateway ゲートウェイ](/gateway/multiple-gateways)）。
- **Canvas ホスト**は Gateway ゲートウェイと同じポートで提供されます（`/__openclaw__/canvas/`、`/__openclaw__/a2ui/`）。ループバック以外にバインドされている場合は、Gateway ゲートウェイ認証で保護されます。
- **リモートアクセス**は通常、SSHトンネルまたは Tailscale VPN を使用します（[リモートアクセス](/gateway/remote)）。

主要な参考資料:

- [Gateway ゲートウェイのアーキテクチャ](/concepts/architecture)
- [Gateway ゲートウェイプロトコル](/gateway/protocol)
- [Gateway ゲートウェイ運用ガイド](/gateway)
- [Webサーフェスとバインドモード](/web)

## ペアリングとID

- [ペアリング概要（ダイレクトメッセージ + ノード）](/channels/pairing)
- [Gateway ゲートウェイ管理のノードペアリング](/gateway/pairing)
- [デバイス CLI（ペアリング + トークンローテーション）](/cli/devices)
- [ペアリング CLI（ダイレクトメッセージ承認）](/cli/pairing)

ローカル信頼:

- ローカル接続（ループバックまたは Gateway ゲートウェイホスト自身の tailnet アドレス）は、同一ホストの UX をスムーズにするためにペアリングを自動承認できます。
- 非ローカルの tailnet/LAN クライアントは、引き続き明示的なペアリング承認が必要です。

## ディスカバリーとトランスポート

- [ディスカバリーとトランスポート](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [リモートアクセス（SSH）](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## ノードとトランスポート

- [ノード概要](/nodes)
- [ブリッジプロトコル（レガシーノード）](/gateway/bridge-protocol)
- [ノード運用ガイド: iOS](/platforms/ios)
- [ノード運用ガイド: Android](/platforms/android)

## セキュリティ

- [セキュリティ概要](/gateway/security)
- [Gateway ゲートウェイ設定リファレンス](/gateway/configuration)
- [トラブルシューティング](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
