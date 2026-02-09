---
summary: "Zalo 個人向けプラグイン：zca-cli による QR ログイン + メッセージング（プラグインのインストール + チャンネル設定 + CLI + ツール）"
read_when:
  - OpenClaw で Zalo Personal（非公式）を利用したい場合
  - zalouser プラグインを設定または開発している場合
title: "Zalo Personal プラグイン"
---

# Zalo Personal（プラグイン）

`zca-cli` を使用して通常の Zalo ユーザーアカウントを自動化する、プラグイン経由の OpenClaw 向け Zalo Personal サポートです。

> **警告:** 非公式の自動化は、アカウントの停止や BAN につながる可能性があります。自己責任で使用してください。 ご自身の責任においてご利用ください。

## 命名

チャンネル id は、**個人用 Zalo ユーザーアカウント**（非公式）を自動化することを明確にするため `zalouser` です。将来の公式 Zalo API 統合の可能性に備えて、`zalo` は予約しています。 「zalo」は将来の公式Zalo API統合のために予約されています。

## 実行場所

このプラグインは **Gateway（ゲートウェイ）プロセス内** で実行されます。

リモートの Gateway を使用している場合は、**Gateway を実行しているマシン** にインストールおよび設定し、その後 Gateway を再起動してください。

## インストール

### オプション A: npm からインストール

```bash
openclaw plugins install @openclaw/zalouser
```

その後、Gateway を再起動してください。

### オプション B: ローカルフォルダーからインストール（開発用）

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

その後、Gateway を再起動してください。

## 前提条件: zca-cli

Gateway マシンには、`PATH` 上に `zca` がインストールされている必要があります。

```bash
zca --version
```

## 設定

チャンネル設定は、`plugins.entries.*` ではなく `channels.zalouser` 配下に配置します。

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

アクション: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
