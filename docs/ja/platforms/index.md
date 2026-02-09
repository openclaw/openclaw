---
summary: "プラットフォーム対応の概要（Gateway（ゲートウェイ）＋コンパニオンアプリ）"
read_when:
  - OS の対応状況やインストール方法を確認したい場合
  - Gateway（ゲートウェイ）をどこで実行するか検討している場合
title: "プラットフォーム"
---

# プラットフォーム

OpenClawコアはTypeScriptで書かれています。 **Node は推奨されるランタイムです**
Bun はゲートウェイ(WhatsApp/Telegramのバグ)には推奨されません。

コンパニオンアプリはmacOS(メニューバーアプリ)とモバイルノード(iOS/Android)に存在します。 Windows と
Linux のコンパニオンアプリが計画されていますが、今日ではゲートウェイは完全にサポートされています。
Windows用のネイティブコンパニオンアプリも計画されています。ゲートウェイはWSL2を介して推奨されます。

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
