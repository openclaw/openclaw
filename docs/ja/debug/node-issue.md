---
summary: Node と tsx による「__name is not a function」クラッシュのメモと回避策
read_when:
  - Node のみの開発スクリプトや watch モードの失敗をデバッグする場合
  - OpenClaw における tsx/esbuild ローダーのクラッシュを調査する場合
title: "Node + tsx クラッシュ"
---

# Node + tsx 「\_\_name is not a function」クラッシュ

## 概要

Node 経由で OpenClaw を `tsx` 付きで実行すると、起動時に次のエラーで失敗します。

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

開発者スクリプトを Bun から `tsx` に切り替えた後に始まりました(`2871657e`, 2026-01-06) 。 同じランタイムパスが Bun で動作しました。

## 環境

- Node: v25.x（v25.3.0 で確認）
- tsx: 4.21.0
- OS: macOS（Node 25 を実行する他のプラットフォームでも再現する可能性あり）

## 再現手順（Node のみ）

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## リポジトリ内の最小再現

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node バージョンの確認

- Node 25.3.0: 失敗
- Node 22.22.0（Homebrew `node@22`）: 失敗
- Node 24: まだ未インストールのため要検証

## 注記 / 仮説

- `tsx` は esbuild を使用して TS/ESM を変換します。 `tsx` は TS/ESM を変換するために esbuild を使用します。esbuild の `keepNames` は `__name` ヘルパーを出力し、関数定義を `__name(...)` でラップします。
- このクラッシュは、実行時に `__name` が存在するが関数ではないことを示しており、Node 25 のローダーパスにおいて当該モジュールのヘルパーが欠落しているか上書きされていることを示唆します。
- 同様の `__name` ヘルパー問題は、ヘルパーが欠落または書き換えられた場合に、他の esbuild 利用者でも報告されています。

## リグレッション履歴

- `2871657e`（2026-01-06）: Bun を任意にするため、スクリプトを Bun から tsx に変更。
- それ以前（Bun パス）では、`openclaw status` と `gateway:watch` は動作していました。

## 回避策

- 開発用スクリプトに Bun を使用する（現在の一時的なリバート）。

- Node + tsc watch を使用し、コンパイル後の出力を実行する:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- ローカルで確認済み: Node 25 では `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` が動作します。

- 可能であれば TS ローダーで esbuild の keepNames を無効化します（`__name` ヘルパーの挿入を防止）。tsx は現在これを公開していません。

- Node LTS（22/24）を `tsx` でテストし、Node 25 固有の問題かどうかを確認します。

## 参考

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## 次のステップ

- Node 22/24 で再現し、Node 25 のリグレッションであることを確認します。
- 既知のリグレッションがある場合は、`tsx` の nightly をテストするか、以前のバージョンに固定します。
- Node LTS でも再現する場合は、`__name` のスタックトレースを添えて、上流に最小再現を報告します。
