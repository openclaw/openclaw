---
summary: "Linux サポート + コンパニオンアプリの状況"
read_when:
  - Linux コンパニオンアプリの状況を調べている
  - プラットフォームカバレッジやコントリビューションを計画している
title: "Linux アプリ"
---

# Linux アプリ

Gateway は Linux で完全にサポートされています。**Node が推奨ランタイムです**。
Bun は Gateway には推奨されません（WhatsApp/Telegram のバグがあるため）。

ネイティブ Linux コンパニオンアプリは計画中です。開発に協力していただける方のコントリビューションを歓迎します。

## 初心者向けクイックパス（VPS）

1. Node 22+ をインストール
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. ラップトップから：`ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. `http://127.0.0.1:18789/` を開いてトークンを貼り付け

ステップバイステップの VPS ガイド：[exe.dev](/install/exe-dev)

## インストール

- [はじめに](/start/getting-started)
- [インストール & 更新](/install/updating)
- オプションのフロー：[Bun（実験的）](/install/bun)、[Nix](/install/nix)、[Docker](/install/docker)

## Gateway

- [Gateway 運用手順書](/gateway)
- [設定](/gateway/configuration)

## Gateway サービスインストール（CLI）

以下のいずれかを使用してください：

```
openclaw onboard --install-daemon
```

または：

```
openclaw gateway install
```

または：

```
openclaw configure
```

プロンプトが表示されたら **Gateway service** を選択してください。

修復/移行：

```
openclaw doctor
```

## システム制御（systemd ユーザーユニット）

OpenClaw はデフォルトで systemd **ユーザー**サービスをインストールします。共有サーバーや
常時稼働サーバーの場合は**システム**サービスを使用してください。完全なユニット例と
ガイダンスは [Gateway 運用手順書](/gateway) にあります。

最小セットアップ：

`~/.config/systemd/user/openclaw-gateway[-<profile>].service` を作成します：

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

有効にします：

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
