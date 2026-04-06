---
read_when:
    - CIジョブが実行された、または実行されなかった理由を理解する必要がある場合
    - 失敗しているGitHub Actionsチェックをデバッグしている場合
summary: CIジョブグラフ、スコープゲート、およびローカルコマンドの対応表
title: CIパイプライン
x-i18n:
    generated_at: "2026-04-02T07:31:58Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 6df608d301136a8aa9d89103635ea3c3240ac62310e9ed520ab256de1154157e
    source_path: ci.md
    workflow: 15
---

# CIパイプライン

CIは`main`へのすべてのプッシュとすべてのプルリクエストで実行されます。スマートスコーピングを使用して、関連のない領域のみが変更された場合に高コストなジョブをスキップします。

## ジョブ概要

| ジョブ               | 目的                                                                   | 実行タイミング                                     |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| `preflight`       | ドキュメントスコープ、変更スコープ、キースキャン、ワークフロー監査、本番依存関係監査 | 常時。ノードベースの監査はドキュメント以外の変更時のみ |
| `docs-scope`      | ドキュメントのみの変更を検出                                                  | 常時                                           |
| `changed-scope`   | 変更された領域を検出（node/macos/android/windows）                   | ドキュメント以外の変更時                                  |
| `check`           | TypeScript型チェック、リント、フォーマット                                            | ドキュメント以外、nodeの変更時                           |
| `check-docs`      | Markdownリント＋リンク切れチェック                                                | ドキュメントの変更時                                  |
| `secrets`         | 漏洩したシークレットの検出                                                | 常時                                           |
| `build-artifacts` | distを一度ビルドし、`release-check`と共有                               | `main`へのプッシュ時、nodeの変更時                   |
| `release-check`   | npm packの内容を検証                                                | ビルド後の`main`へのプッシュ時                     |
| `checks`          | PRではNodeテスト＋プロトコルチェック、プッシュ時はBun互換性テスト                    | ドキュメント以外、nodeの変更時                           |
| `compat-node22`   | サポートされる最小Nodeランタイムの互換性チェック                              | `main`へのプッシュ時、nodeの変更時                   |
| `checks-windows`  | Windows固有のテスト                                                    | ドキュメント以外、Windows関連の変更時               |
| `macos`           | Swiftリント/ビルド/テスト＋TSテスト                                          | macOS変更を含むPR時                           |
| `android`         | Gradleビルド＋テスト                                                      | ドキュメント以外、Androidの変更時                        |

## フェイルファスト順序

低コストなチェックが先に失敗するよう、ジョブは順序付けされています：

1. `docs-scope` + `changed-scope` + `check` + `secrets`（並列、低コストなゲートを先に実行）
2. PR：`checks`（Linux Nodeテストを2シャードに分割）、`checks-windows`、`macos`、`android`
3. `main`へのプッシュ：`build-artifacts` + `release-check` + Bun互換性テスト + `compat-node22`

スコープロジックは`scripts/ci-changed-scope.mjs`にあり、`src/scripts/ci-changed-scope.test.ts`のユニットテストでカバーされています。
同じ共有スコープモジュールは、より狭い`changed-smoke`ゲートを通じて別の`install-smoke`ワークフローも駆動するため、Docker/インストールスモークテストはインストール、パッケージング、およびコンテナ関連の変更時のみ実行されます。

## ランナー

| ランナー                           | ジョブ                                       |
| -------------------------------- | ------------------------------------------ |
| `blacksmith-16vcpu-ubuntu-2404`  | スコープ検出を含むほとんどのLinuxジョブ |
| `blacksmith-32vcpu-windows-2025` | `checks-windows`                           |
| `macos-latest`                   | `macos`、`ios`                             |

## ローカルでの同等コマンド

```bash
pnpm check          # types + lint + format
pnpm test           # vitest tests
pnpm check:docs     # docs format + lint + broken links
pnpm release:check  # validate npm pack
```
