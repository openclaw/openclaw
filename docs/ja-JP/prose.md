---
summary: "OpenProse: OpenClaw での .prose ワークフロー、スラッシュコマンド、状態"
read_when:
  - .prose ワークフローを実行または作成したい場合
  - OpenProse プラグインを有効にしたい場合
  - 状態ストレージを理解する必要がある場合
title: "OpenProse"
---

# OpenProse

OpenProse は、AI セッションをオーケストレーションするためのポータブルな Markdown ファースト型ワークフローフォーマットです。OpenClaw では、OpenProse スキルパックと `/prose` スラッシュコマンドをインストールするプラグインとして提供されます。プログラムは `.prose` ファイルに保存され、明示的な制御フローで複数のサブエージェントを起動できます。

公式サイト: [https://www.prose.md](https://www.prose.md)

## できること

- 明示的な並列処理を持つマルチエージェントリサーチ + 合成。
- 繰り返し可能な承認セーフワークフロー（コードレビュー、インシデントトリアージ、コンテンツパイプライン）。
- サポートされているエージェントランタイム間で実行できる再利用可能な `.prose` プログラム。

## インストール + 有効化

バンドルされたプラグインはデフォルトで無効になっています。OpenProse を有効化します:

```bash
openclaw plugins enable open-prose
```

プラグインを有効化した後、Gateway を再起動してください。

開発/ローカルチェックアウト: `openclaw plugins install ./extensions/open-prose`

関連ドキュメント: [プラグイン](/tools/plugin)、[プラグインマニフェスト](/plugins/manifest)、[スキル](/tools/skills)。

## スラッシュコマンド

OpenProse は `/prose` をユーザーが呼び出せるスキルコマンドとして登録します。OpenProse VM 命令にルーティングされ、内部で OpenClaw ツールを使用します。

よく使うコマンド:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## 例: シンプルな `.prose` ファイル

```prose
# Research + synthesis with two agents running in parallel.

input topic: "What should we research?"

agent researcher:
  model: sonnet
  prompt: "You research thoroughly and cite sources."

agent writer:
  model: opus
  prompt: "You write a concise summary."

parallel:
  findings = session: researcher
    prompt: "Research {topic}."
  draft = session: writer
    prompt: "Summarize {topic}."

session "Merge the findings + draft into a final answer."
context: { findings, draft }
```

## ファイルの保存場所

OpenProse はワークスペース内の `.prose/` の下に状態を保持します:

```
.prose/
├── .env
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose
│       ├── state.md
│       ├── bindings/
│       └── agents/
└── agents/
```

ユーザーレベルの永続エージェントは以下に保存されます:

```
~/.prose/agents/
```

## 状態モード

OpenProse は複数の状態バックエンドをサポートします:

- **filesystem**（デフォルト）: `.prose/runs/...`
- **in-context**: 小さなプログラム向けの一時的なもの
- **sqlite**（試験的）: `sqlite3` バイナリが必要
- **postgres**（試験的）: `psql` と接続文字列が必要

メモ:

- sqlite/postgres はオプトインで試験的です。
- postgres クレデンシャルはサブエージェントログに流れ込みます。専用の最小権限 DB を使用してください。

## リモートプログラム

`/prose run <handle/slug>` は `https://p.prose.md/<handle>/<slug>` に解決されます。
直接 URL はそのままフェッチされます。これは `web_fetch` ツール（または POST には `exec`）を使用します。

## OpenClaw ランタイムマッピング

OpenProse プログラムは OpenClaw プリミティブにマッピングされます:

| OpenProse コンセプト      | OpenClaw ツール  |
| ------------------------- | ---------------- |
| セッション起動 / タスクツール | `sessions_spawn` |
| ファイル読み取り/書き込み | `read` / `write` |
| Web フェッチ              | `web_fetch`      |

ツールアローリストがこれらのツールをブロックしている場合、OpenProse プログラムは失敗します。[スキルコンフィグ](/tools/skills-config) を参照してください。

## セキュリティ + 承認

`.prose` ファイルはコードと同様に扱ってください。実行前にレビューしてください。OpenClaw ツールアローリストと承認ゲートを使用して副作用を制御します。

決定論的で承認ゲートのワークフローについては、[Lobster](/tools/lobster) と比較してください。
