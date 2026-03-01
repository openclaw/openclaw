---
summary: "Bunワークフロー（実験的）：pnpmとの比較、インストールと注意点"
read_when:
  - 最速のローカル開発ループが必要な場合（bun + watch）
  - Bunのインストール/パッチ/ライフサイクルスクリプトの問題に遭遇した場合
title: "Bun（実験的）"
---

# Bun（実験的）

目標：pnpmワークフローから逸脱せずに、このリポジトリを**Bun**で実行します（オプション、WhatsApp/Telegramには非推奨）。

警告：**Gatewayランタイムには推奨されません**（WhatsApp/Telegramのバグがあります）。本番環境ではNodeを使用してください。

## ステータス

- BunはTypeScriptを直接実行するためのオプションのローカルランタイムです（`bun run ...`、`bun --watch ...`）。
- `pnpm`がビルドのデフォルトであり、引き続き完全にサポートされています（一部のドキュメントツールでも使用されています）。
- Bunは`pnpm-lock.yaml`を使用できず、無視されます。

## インストール

デフォルト：

```sh
bun install
```

注意：`bun.lock`/`bun.lockb`はgitignoreされているため、リポジトリに影響はありません。ロックファイルの書き込みを_完全に防ぎたい_場合：

```sh
bun install --no-save
```

## ビルド / テスト（Bun）

```sh
bun run build
bun run vitest run
```

## Bunライフサイクルスクリプト（デフォルトでブロック）

Bunは明示的に信頼されていない限り、依存関係のライフサイクルスクリプトをブロックする場合があります（`bun pm untrusted` / `bun pm trust`）。
このリポジトリでは、一般的にブロックされるスクリプトは必須ではありません：

- `@whiskeysockets/baileys` `preinstall`：Nodeメジャーバージョン >= 20をチェック（Node 22+で実行しています）。
- `protobufjs` `postinstall`：互換性のないバージョンスキームに関する警告を出力（ビルドアーティファクトなし）。

これらのスクリプトが必要な実際のランタイムの問題に遭遇した場合は、明示的に信頼してください：

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## 注意点

- 一部のスクリプトはまだpnpmをハードコードしています（例：`docs:build`、`ui:*`、`protocol:check`）。これらは現時点ではpnpmで実行してください。
