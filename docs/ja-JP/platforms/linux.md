---
read_when:
    - Linux コンパニオンアプリの状況を確認する場合
    - プラットフォームカバレッジや貢献を計画する場合
summary: Linux サポート + コンパニオンアプリの状況
title: Linux アプリ
x-i18n:
    generated_at: "2026-04-02T07:47:18Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 178609b7e81e06339e3349bccbb950d7bd39b5938382d75eef668f723fa7fed8
    source_path: platforms/linux.md
    workflow: 15
---

# Linux アプリ

Gateway ゲートウェイは Linux で完全にサポートされています。**Node が推奨ランタイムです**。
Bun は Gateway ゲートウェイには推奨されません（WhatsApp/Telegram のバグがあります）。

ネイティブ Linux コンパニオンアプリは計画中です。構築を手伝いたい方からの貢献を歓迎します。

## 初心者向けクイックパス（VPS）

1. Node 24 をインストール（推奨。Node 22 LTS、現在 `22.14+` も互換性のため引き続き動作します）
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. ノートパソコンから: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. `http://127.0.0.1:18789/` を開いてトークンを貼り付ける

Linux サーバーの完全ガイド: [Linux サーバー](/vps)。ステップバイステップの VPS 例: [exe.dev](/install/exe-dev)

## インストール

- [はじめに](/start/getting-started)
- [インストールと更新](/install/updating)
- オプションのフロー: [Bun（実験的）](/install/bun)、[Nix](/install/nix)、[Docker](/install/docker)

## Gateway ゲートウェイ

- [Gateway ゲートウェイ運用ガイド](/gateway)
- [設定](/gateway/configuration)

## Gateway ゲートウェイサービスのインストール（CLI）

以下のいずれかを使用します:

```
openclaw onboard --install-daemon
```

または:

```
openclaw gateway install
```

または:

```
openclaw configure
```

プロンプトが表示されたら **Gateway ゲートウェイサービス**を選択します。

修復/移行:

```
openclaw doctor
```

## システム制御（systemd ユーザーユニット）

OpenClaw はデフォルトで systemd **ユーザー**サービスをインストールします。共有サーバーや
常時稼働サーバーには**システム**サービスを使用してください。完全なユニットの例とガイダンスは
[Gateway ゲートウェイ運用ガイド](/gateway)にあります。

最小限のセットアップ:

`~/.config/systemd/user/openclaw-gateway[-<profile>].service` を作成します:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

有効化します:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
