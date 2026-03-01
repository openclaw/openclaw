---
summary: "Zalo Personal プラグイン: zca-cli 経由の QR ログイン + メッセージング（プラグインのインストール + チャンネル設定 + CLI + ツール）"
read_when:
  - OpenClaw で Zalo Personal（非公式）サポートが必要な場合
  - zalouser プラグインを設定または開発している場合
title: "Zalo Personal プラグイン"
---

# Zalo Personal（プラグイン）

`zca-cli` を使用して通常の Zalo ユーザーアカウントを自動化することで、プラグインを通じて OpenClaw に Zalo Personal サポートを追加します。

> **警告:** 非公式の自動化はアカウントの停止/バンにつながる可能性があります。自己責任でご利用ください。

## 命名について

チャンネル ID は `zalouser` です。これは**個人の Zalo ユーザーアカウント**（非公式）を自動化することを明示するためです。`zalo` は将来的な公式 Zalo API 統合のために予約しています。

## 実行場所

このプラグインは **Gateway プロセス内**で実行されます。

リモート Gateway を使用する場合は、**Gateway を実行しているマシン**にインストール/設定してから、Gateway を再起動してください。

## インストール

### オプション A: npm からインストール

```bash
openclaw plugins install @openclaw/zalouser
```

その後、Gateway を再起動してください。

### オプション B: ローカルフォルダからインストール（開発）

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

その後、Gateway を再起動してください。

## 前提条件: zca-cli

Gateway マシンの `PATH` に `zca` が必要です。

```bash
zca --version
```

## 設定

チャンネル設定は `channels.zalouser` の下にあります（`plugins.entries.*` ではありません）。

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

## CLI

```bash
openclaw channels login --channel zalouser
openclaw channels logout --channel zalouser
openclaw channels status --probe
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw"
openclaw directory peers list --channel zalouser --query "name"
```

## エージェントツール

ツール名: `zalouser`

アクション: `send`、`image`、`link`、`friends`、`groups`、`me`、`status`
