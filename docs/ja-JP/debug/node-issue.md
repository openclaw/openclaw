---
summary: Node + tsx の "__name is not a function" クラッシュの注意事項と回避策
read_when:
  - Node 専用の開発スクリプトやウォッチモードの失敗をデバッグする場合
  - OpenClaw での tsx/esbuild ローダーのクラッシュを調査する場合
title: "Node + tsx クラッシュ"
---

# Node + tsx 「\_\_name is not a function」クラッシュ

## 概要

Node で `tsx` を使用して OpenClaw を実行すると、起動時に以下のエラーが発生します。

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

この問題は、開発スクリプトを Bun から `tsx` に切り替えた後（コミット `2871657e`、2026-01-06）に発生するようになりました。同じランタイムパスは Bun では正常に動作していました。

## 環境

- Node: v25.x（v25.3.0 で確認）
- tsx: 4.21.0
- OS: macOS（Node 25 を実行する他のプラットフォームでも再現する可能性があります）

## 再現手順（Node 専用）

```bash
# リポジトリルートで
node --version
pnpm install
node --import tsx src/entry.ts status
```

## リポジトリ内での最小再現

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node バージョン確認

- Node 25.3.0: 失敗
- Node 22.22.0（Homebrew `node@22`）: 失敗
- Node 24: 未インストール。要確認

## 注意事項 / 仮説

- `tsx` は esbuild を使用して TS/ESM を変換します。esbuild の `keepNames` は `__name` ヘルパーを出力し、関数定義を `__name(...)` でラップします。
- このクラッシュは、`__name` が存在するもののランタイムで関数ではないことを示しています。これは、Node 25 のローダーパスでこのモジュールのヘルパーが欠けているか上書きされていることを示唆しています。
- 類似の `__name` ヘルパーの問題は、ヘルパーが欠けているか書き換えられている場合に、他の esbuild コンシューマーでも報告されています。

## リグレッション履歴

- `2871657e`（2026-01-06）: Bun をオプションにするために、スクリプトを Bun から tsx に変更。
- それ以前（Bun パス）: `openclaw status` と `gateway:watch` は正常に動作していました。

## 回避策

- 開発スクリプトに Bun を使用する（現在の一時的な差し戻し）。
- Node + tsc ウォッチを使用して、コンパイル済みの出力を実行する:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- ローカルで確認済み: `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` は Node 25 で動作します。
- TS ローダーで esbuild の keepNames を無効にする（`__name` ヘルパーの挿入を防ぐ）。ただし、tsx は現在これを公開していません。
- Node LTS（22/24）で `tsx` をテストして、Node 25 固有の問題かどうかを確認する。

## 参考リンク

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## 次のステップ

- Node 22/24 で再現して、Node 25 のリグレッションかどうかを確認する。
- 既知のリグレッションがある場合は `tsx` のナイトリーをテストするか、以前のバージョンにピン留めする。
- Node LTS で再現する場合は、`__name` スタックトレースを含む最小再現を upstream に報告する。
