---
summary: "Bun ワークフロー（実験的）：pnpm との違い、インストール時の注意点"
read_when:
  - Bun + watch による最速のローカル開発ループを求めている場合
  - Bun の install / patch / ライフサイクルスクリプトの問題に遭遇した場合
title: "Bun（実験的）"
---

# Bun（実験的）

目的：pnpm のワークフローから逸脱せずに、このリポジトリを **Bun** で実行します（任意。WhatsApp / Telegram では非推奨）。

⚠️ **ゲートウェイのランタイムにはお勧めしません** (WhatsApp/Telegramのバグ)。 本番環境にノードを使用します。

## Status

- Bun は、TypeScript を直接実行するための任意のローカルランタイムです（`bun run …`, `bun --watch …`）。
- `pnpm` はビルドのデフォルトであり、引き続き完全にサポートされています（いくつかのドキュメント用ツールでも使用されています）。
- Bun は `pnpm-lock.yaml` を使用できず、無視します。

## Install

デフォルト：

```sh
bun install
```

注記：`bun.lock` / `bun.lockb` は gitignore されているため、どちらを使ってもリポジトリに差分は発生しません。_ロックファイルを書き込まない_ 場合は次を使用してください： _lockfile の書き込みをしたくない場合は_:

```sh
bun install --no-save
```

## Build / Test（Bun）

```sh
bun run build
bun run vitest run
```

## Bun ライフサイクルスクリプト（デフォルトではブロック）

Bun は、明示的に信頼されていない依存関係のライフサイクルスクリプトをブロックする場合があります（`bun pm untrusted` / `bun pm trust`）。
本リポジトリでは、一般的にブロックされる以下のスクリプトは不要です：
このリポジトリでは、一般的にブロックされたスクリプトは必要ありません。

- `@whiskeysockets/baileys` `preinstall`：Node のメジャーバージョンが 20 以上であることを確認します（本リポジトリでは Node 22+ を使用します）。
- `protobufjs` `postinstall`：互換性のないバージョンスキームに関する警告を出力します（ビルド成果物は生成されません）。

これらのスクリプトが必要となる実際のランタイム問題に遭遇した場合は、明示的に信頼してください：

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Caveats

- 一部のスクリプトは依然として pnpm をハードコードしています（例：`docs:build`, `ui:*`, `protocol:check`）。現時点では、これらは pnpm 経由で実行してください。 今のところpnpm経由でこれらを実行します。
