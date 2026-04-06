---
read_when:
    - Node専用の開発スクリプトやウォッチモードの障害をデバッグする場合
    - OpenClawにおけるtsx/esbuildローダーのクラッシュを調査する場合
summary: Node + tsx の「__name is not a function」クラッシュに関するメモと回避策
title: Node + tsx クラッシュ
x-i18n:
    generated_at: "2026-04-02T07:40:31Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: f5beab7cdfe7679680f65176234a617293ce495886cfffb151518adfa61dc8dc
    source_path: debug/node-issue.md
    workflow: 15
---

# Node + tsx「\_\_name is not a function」クラッシュ

## 概要

Nodeで`tsx`を使用してOpenClawを実行すると、起動時に以下のエラーで失敗します:

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

これは開発スクリプトをBunから`tsx`に切り替えた後（コミット`2871657e`、2026-01-06）に発生し始めました。同じランタイムパスはBunでは動作していました。

## 環境

- Node: v25.x（v25.3.0で確認）
- tsx: 4.21.0
- OS: macOS（Node 25が動作する他のプラットフォームでも再現する可能性が高い）

## 再現手順（Node専用）

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

## Nodeバージョンの確認

- Node 25.3.0: 失敗
- Node 22.22.0（Homebrew `node@22`）: 失敗
- Node 24: 未インストールのため検証が必要

## メモ / 仮説

- `tsx`はesbuildを使用してTS/ESMを変換します。esbuildの`keepNames`は`__name`ヘルパーを出力し、関数定義を`__name(...)`でラップします。
- クラッシュは`__name`が存在するが実行時に関数ではないことを示しており、Node 25のローダーパスでこのモジュールのヘルパーが欠落しているか上書きされていることを意味します。
- 同様の`__name`ヘルパーの問題は、ヘルパーが欠落または書き換えられた場合に、他のesbuild利用者でも報告されています。

## リグレッション履歴

- `2871657e`（2026-01-06）: Bunをオプションにするためスクリプトがtsxに変更されました。
- それ以前（Bunパス）では、`openclaw status`と`gateway:watch`は動作していました。

## 回避策

- 開発スクリプトにはBunを使用する（現在の一時的なリバート）。
- Node + tscウォッチを使用し、コンパイル済みの出力を実行する:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- ローカルで確認済み: `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status`はNode 25で動作します。
- TSローダーでesbuildのkeepNamesを無効にする（`__name`ヘルパーの挿入を防止）。ただしtsxは現在この設定を公開していません。
- Node LTS（22/24）で`tsx`をテストし、問題がNode 25固有かどうかを確認する。

## 参考資料

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## 次のステップ

- Node 22/24で再現し、Node 25のリグレッションであることを確認する。
- `tsx`のnightlyをテストするか、既知のリグレッションがある場合は以前のバージョンにピン留めする。
- Node LTSで再現する場合、`__name`のスタックトレースを含む最小再現をアップストリームに報告する。
