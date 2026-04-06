---
read_when:
    - OpenClaw で Zalo Personal（非公式）サポートを利用したい場合
    - zalouser プラグインを設定または開発している場合
summary: 'Zalo Personal プラグイン: QR ログイン + ネイティブ zca-js によるメッセージング（プラグインインストール + チャネル設定 + ツール）'
title: Zalo Personal プラグイン
x-i18n:
    generated_at: "2026-04-02T08:36:51Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 3218c3ee34f36466d952aec1b479d451a6235c7c46918beb28698234a7fd0968
    source_path: plugins/zalouser.md
    workflow: 15
---

# Zalo Personal（プラグイン）

ネイティブ `zca-js` を使用して通常の Zalo ユーザーアカウントを自動化する、OpenClaw 向け Zalo Personal サポートプラグインです。

> **警告:** 非公式の自動化はアカウントの停止やBANにつながる可能性があります。自己責任でご利用ください。

## 命名規則

チャネル ID は `zalouser` です。これは**個人の Zalo ユーザーアカウント**（非公式）を自動化することを明示するためです。将来的な公式 Zalo API 統合に備えて、`zalo` は予約されています。

## 実行場所

このプラグインは **Gateway ゲートウェイプロセス内部**で実行されます。

リモート Gateway ゲートウェイを使用している場合は、**Gateway ゲートウェイを実行しているマシン**でインストールと設定を行い、Gateway ゲートウェイを再起動してください。

外部の `zca`/`openzca` CLI バイナリは不要です。

## インストール

### オプション A: npm からインストール

```bash
openclaw plugins install @openclaw/zalouser
```

インストール後に Gateway ゲートウェイを再起動してください。

### オプション B: ローカルフォルダからインストール（開発用）

```bash
PLUGIN_SRC=./path/to/local/zalouser-plugin
openclaw plugins install "$PLUGIN_SRC"
cd "$PLUGIN_SRC" && pnpm install
```

インストール後に Gateway ゲートウェイを再起動してください。

## 設定

チャネル設定は `channels.zalouser` 配下にあります（`plugins.entries.*` ではありません）:

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

チャネルメッセージアクションでは、メッセージリアクション用の `react` もサポートしています。
