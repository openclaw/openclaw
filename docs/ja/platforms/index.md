---
summary: "プラットフォーム対応の概要（Gateway（ゲートウェイ）＋コンパニオンアプリ）"
read_when:
  - OS の対応状況やインストール方法を確認したい場合
  - Gateway（ゲートウェイ）をどこで実行するか検討している場合
title: "プラットフォーム"
x-i18n:
  source_path: platforms/index.md
  source_hash: 959479995f9ecca3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:22:27Z
---

# プラットフォーム

OpenClaw のコアは TypeScript で記述されています。**Node が推奨ランタイムです**。
Bun は Gateway（ゲートウェイ）では推奨されていません（WhatsApp / Telegram の不具合があります）。

コンパニオンアプリは macOS（メニューバーアプリ）およびモバイルノード（iOS / Android）向けに提供されています。Windows および
Linux 向けのコンパニオンアプリは計画中ですが、Gateway（ゲートウェイ）は現在すでに完全にサポートされています。
Windows 向けのネイティブコンパニオンアプリも計画中であり、Gateway（ゲートウェイ）は WSL2 経由での利用を推奨します。

## OS を選択

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS とホスティング

- VPS ハブ: [VPS hosting](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner（Docker）: [Hetzner](/install/hetzner)
- GCP（Compute Engine）: [GCP](/install/gcp)
- exe.dev（VM＋HTTPS プロキシ）: [exe.dev](/install/exe-dev)

## 共通リンク

- インストールガイド: [Getting Started](/start/getting-started)
- Gateway（ゲートウェイ）ランブック: [Gateway](/gateway)
- Gateway（ゲートウェイ）設定: [Configuration](/gateway/configuration)
- サービスステータス: `openclaw gateway status`

## Gateway（ゲートウェイ）サービスのインストール（CLI）

以下のいずれかを使用します（すべてサポートされています）:

- ウィザード（推奨）: `openclaw onboard --install-daemon`
- 直接: `openclaw gateway install`
- 設定フロー: `openclaw configure` → **Gateway サービス**を選択
- 修復／移行: `openclaw doctor`（サービスのインストールまたは修復を提案します）

サービスのターゲットは OS によって異なります:

- macOS: LaunchAgent（`bot.molt.gateway` または `bot.molt.<profile>`；レガシー `com.openclaw.*`）
- Linux / WSL2: systemd ユーザーサービス（`openclaw-gateway[-<profile>].service`）
