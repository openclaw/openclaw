# Windows Spawn EINVAL Plugin Install Fix

## 日付

2026-02-20

## 目的

OpenClawのプラグインインストール時（`openclaw onboard`でLINE等のプラグインをnpmからダウンロード時）に、Windows環境で `Error: spawn EINVAL` が発生する問題を解決する。

## 問題の原因

- `src/process/exec.ts` にて、npmのコマンドを動的に `.cmd` へ変換して実行しているが、`shell: false` のままで `spawn` が実行されていた。
- 最近のNode.js (v20以上等) では、CVE-2024-27980 のセキュリティ対策により、Windowsにおいて `.bat` や `.cmd` ファイルを `shell: true` なしで `spawn` しようとすると、安全のため意図的に `EINVAL` エラーをスローするよう設計が変更されている。
- 元々のコードには `shouldSpawnWithShell` 関数があり、コマンドインジェクション防止のため意図的にWindowsでも `shell: false` を強制していたが、この例外仕様に引っ掛かっていた。

## 修正内容

1. `src/process/exec.ts` 内の `shouldSpawnWithShell()` を修正。
2. Windows環境（`win32`）かつ、実行対象ファイルの拡張子が `.cmd` または `.bat` の場合のみ例外的に `shell: true` を返すよう変更。
3. `shell: true` とすることでNode.js側のデフォルト引数エスケープ処理に委ねながら、正常に `npm.cmd` が起動できるようにした。

## 検証

- TypeScriptファイルの修正後、リポジトリのルートで `npx tsdown` を実行してトランスパイル。
- `spawn EINVAL` で落ちていたプラグインインストールが正常に行えるか、ユーザのOnboard画面の再試行にて動作確認を行う。

以上
