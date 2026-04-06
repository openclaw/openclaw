---
read_when:
    - OSサポートやインストールパスを調べている場合
    - Gateway ゲートウェイの実行場所を決定する場合
summary: プラットフォームサポートの概要（Gateway ゲートウェイ + コンパニオンアプリ）
title: プラットフォーム
x-i18n:
    generated_at: "2026-04-02T07:46:58Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 27bedc4a4c540383b1f3ada6d4e163d139d5bd43b32d9a49d53f39fe02122c8e
    source_path: platforms/index.md
    workflow: 15
---

# プラットフォーム

OpenClawのコアはTypeScriptで書かれている。**Nodeが推奨ランタイムである**。
BunはGateway ゲートウェイには推奨されない（WhatsApp/Telegramのバグがあるため）。

コンパニオンアプリはmacOS（メニューバーアプリ）およびモバイルノード（iOS/Android）向けに存在する。WindowsおよびLinuxのコンパニオンアプリは計画中だが、Gateway ゲートウェイは現在完全にサポートされている。
Windows向けのネイティブコンパニオンアプリも計画中である。Gateway ゲートウェイはWSL2経由での使用が推奨される。

## OSを選択する

- macOS：[macOS](/platforms/macos)
- iOS：[iOS](/platforms/ios)
- Android：[Android](/platforms/android)
- Windows：[Windows](/platforms/windows)
- Linux：[Linux](/platforms/linux)

## VPSとホスティング

- VPSハブ：[VPSホスティング](/vps)
- Fly.io：[Fly.io](/install/fly)
- Hetzner（Docker）：[Hetzner](/install/hetzner)
- GCP（Compute Engine）：[GCP](/install/gcp)
- Azure（Linux VM）：[Azure](/install/azure)
- exe.dev（VM + HTTPSプロキシ）：[exe.dev](/install/exe-dev)

## 共通リンク

- インストールガイド：[はじめに](/start/getting-started)
- Gateway ゲートウェイランブック：[Gateway ゲートウェイ](/gateway)
- Gateway ゲートウェイ設定：[設定](/gateway/configuration)
- サービスステータス：`openclaw gateway status`

## Gateway ゲートウェイサービスインストール（CLI）

以下のいずれかを使用する（すべてサポート済み）：

- ウィザード（推奨）：`openclaw onboard --install-daemon`
- 直接：`openclaw gateway install`
- 設定フロー：`openclaw configure` → **Gateway ゲートウェイサービス**を選択
- 修復/移行：`openclaw doctor`（サービスのインストールまたは修正を提案する）

サービスのターゲットはOSによって異なる：

- macOS：LaunchAgent（`ai.openclaw.gateway`または`ai.openclaw.<profile>`、レガシー`com.openclaw.*`）
- Linux/WSL2：systemdユーザーサービス（`openclaw-gateway[-<profile>].service`）
