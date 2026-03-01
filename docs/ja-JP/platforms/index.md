---
summary: "プラットフォームサポートの概要（Gateway + コンパニオンアプリ）"
read_when:
  - OS サポートやインストールパスを調べている
  - Gateway の実行環境を検討している
title: "プラットフォーム"
---

# プラットフォーム

OpenClaw のコアは TypeScript で書かれています。**Node が推奨ランタイムです**。
Bun は Gateway には推奨されません（WhatsApp/Telegram のバグがあるため）。

コンパニオンアプリは macOS（メニューバーアプリ）およびモバイルノード（iOS/Android）向けに提供されています。Windows と
Linux のコンパニオンアプリは計画中ですが、Gateway は現在でも完全にサポートされています。
Windows 向けのネイティブコンパニオンアプリも計画中です。Gateway は WSL2 経由での利用が推奨されます。

## OS を選択する

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS & ホスティング

- VPS ハブ: [VPS ホスティング](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + HTTPS プロキシ): [exe.dev](/install/exe-dev)

## 共通リンク

- インストールガイド: [はじめに](/start/getting-started)
- Gateway 運用手順書: [Gateway](/gateway)
- Gateway 設定: [設定](/gateway/configuration)
- サービスステータス: `openclaw gateway status`

## Gateway サービスインストール（CLI）

以下のいずれかを使用してください（すべてサポートされています）：

- ウィザード（推奨）: `openclaw onboard --install-daemon`
- 直接: `openclaw gateway install`
- 設定フロー: `openclaw configure` → **Gateway service** を選択
- 修復/移行: `openclaw doctor`（サービスのインストールまたは修正を提案します）

サービスのターゲットは OS によって異なります：

- macOS: LaunchAgent (`ai.openclaw.gateway` または `ai.openclaw.<profile>`; レガシー `com.openclaw.*`)
- Linux/WSL2: systemd ユーザーサービス (`openclaw-gateway[-<profile>].service`)
