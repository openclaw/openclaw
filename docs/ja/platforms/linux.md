---
summary: "Linux のサポートおよびコンパニオンアプリの状況"
read_when:
  - Linux のコンパニオンアプリの状況を確認したい場合
  - Planning platform coverage or contribution
title: "Linux アプリ"
---

# Linux アプリ

ゲートウェイは Linux で完全にサポートされています。 **Node は推奨されるランタイムです**
Bun はゲートウェイ(WhatsApp/Telegramのバグ)には推奨されません。

ネイティブの Linux 向けコンパニオンアプリは計画中です。構築を手伝っていただける場合は、コントリビューションを歓迎します。 あなたが1を構築するのを助けたい場合は、貢献を歓迎します。

## 初心者向けクイックパス（VPS）

1. Node 22+ をインストールします
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. ノートパソコンから: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. `http://127.0.0.1:18789/` を開き、トークンを貼り付けます

VPS のステップバイステップガイド: [exe.dev](/install/exe-dev)

## インストール

- [はじめに](/start/getting-started)
- [インストールと更新](/install/updating)
- 任意のフロー: [Bun（実験的）](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway（ゲートウェイ）

- [Gateway ランブック](/gateway)
- [設定](/gateway/configuration)

## Gateway サービスのインストール（CLI）

次のいずれかを使用します。

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

プロンプトが表示されたら **Gateway service** を選択します。

修復 / 移行:

```
openclaw doctor
```

## システム制御（systemd ユーザーユニット）

OpenClaw は、デフォルトで systemd の **ユーザー** サービスをインストールします。共有または常時稼働のサーバーでは **システム** サービスを使用してください。完全なユニット例とガイダンスは [Gateway ランブック](/gateway) にあります。 **system**
サービスを共有または常時オンサーバーに使用します。 完全なユニットの例とガイダンス
は[Gateway runbook](/gateway)にあります。

最小構成:

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
