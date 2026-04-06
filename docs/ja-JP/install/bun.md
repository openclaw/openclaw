---
read_when:
    - 最速のローカル開発ループ（bun + watch）を使いたい
    - Bun のインストール/パッチ/ライフサイクルスクリプトで問題が発生した
summary: Bun ワークフロー（実験的）：インストール方法と pnpm との違いに関する注意点
title: Bun（実験的）
x-i18n:
    generated_at: "2026-04-02T07:44:29Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: b0845567834124bb9206db64df013dc29f3b61a04da4f7e7f0c2823a9ecd67a6
    source_path: install/bun.md
    workflow: 15
---

# Bun（実験的）

<Warning>
Bun は **Gateway ゲートウェイランタイムとしては推奨されません**（WhatsApp および Telegram で既知の問題があります）。本番環境では Node を使用してください。
</Warning>

Bun は、TypeScript を直接実行するための（`bun run ...`、`bun --watch ...`）オプションのローカルランタイムです。デフォルトのパッケージマネージャーは引き続き `pnpm` であり、完全にサポートされ、ドキュメントツールでも使用されています。Bun は `pnpm-lock.yaml` を使用できず、無視します。

## インストール

<Steps>
  <Step title="依存関係のインストール">
    ```sh
    bun install
    ```

    `bun.lock` / `bun.lockb` は gitignore されているため、リポジトリに変更が発生することはありません。ロックファイルの書き込みを完全にスキップするには：

    ```sh
    bun install --no-save
    ```

  </Step>
  <Step title="ビルドとテスト">
    ```sh
    bun run build
    bun run vitest run
    ```
  </Step>
</Steps>

## ライフサイクルスクリプト

Bun は、明示的に信頼されていない限り、依存関係のライフサイクルスクリプトをブロックします。このリポジトリでは、よくブロックされるスクリプトは必須ではありません：

- `@whiskeysockets/baileys` の `preinstall` -- Node メジャーバージョン >= 20 をチェック（OpenClaw はデフォルトで Node 24 を使用し、Node 22 LTS（現在 `22.14+`）も引き続きサポート）
- `protobufjs` の `postinstall` -- 互換性のないバージョンスキームに関する警告を出力（ビルド成果物なし）

これらのスクリプトが必要なランタイムの問題が発生した場合は、明示的に信頼してください：

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## 注意事項

一部のスクリプトは依然として pnpm をハードコードしています（例：`docs:build`、`ui:*`、`protocol:check`）。これらは現時点では pnpm 経由で実行してください。
