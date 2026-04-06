---
read_when:
    - .prose ワークフローを実行または作成したい場合
    - OpenProse プラグインを有効にしたい場合
    - 状態のストレージについて理解したい場合
summary: 'OpenProse: OpenClaw における .prose ワークフロー、スラッシュコマンド、および状態管理'
title: OpenProse
x-i18n:
    generated_at: "2026-04-02T08:37:11Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 95f86ed3029c5599b6a6bed1f75b2e10c8808cf7ffa5e33dbfb1801a7f65f405
    source_path: prose.md
    workflow: 15
---

# OpenProse

OpenProse は、AI セッションをオーケストレーションするための、ポータブルな Markdown ファーストのワークフロー形式です。OpenClaw では、OpenProse Skills パックと `/prose` スラッシュコマンドをインストールするプラグインとして提供されます。プログラムは `.prose` ファイルに記述され、明示的な制御フローで複数のサブエージェントを生成できます。

公式サイト: [https://www.prose.md](https://www.prose.md)

## できること

- 明示的な並列処理によるマルチエージェントのリサーチと統合。
- 再現可能な承認対応ワークフロー（コードレビュー、インシデントトリアージ、コンテンツパイプライン）。
- サポートされているエージェントランタイム間で実行可能な再利用可能な `.prose` プログラム。

## インストールと有効化

バンドルプラグインはデフォルトで無効になっています。OpenProse を有効にするには:

```bash
openclaw plugins enable open-prose
```

プラグインを有効にした後、Gateway ゲートウェイを再起動してください。

開発/ローカルチェックアウト: `openclaw plugins install ./path/to/local/open-prose-plugin`

関連ドキュメント: [プラグイン](/tools/plugin)、[プラグインマニフェスト](/plugins/manifest)、[Skills](/tools/skills)。

## スラッシュコマンド

OpenProse はユーザーが呼び出せる Skills コマンドとして `/prose` を登録します。OpenProse VM の命令にルーティングされ、内部では OpenClaw のツールを使用します。

主なコマンド:

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

## ファイルの場所

OpenProse はワークスペース内の `.prose/` 配下に状態を保持します:

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

OpenProse は複数の状態バックエンドをサポートしています:

- **filesystem**（デフォルト）: `.prose/runs/...`
- **in-context**: 一時的、小規模プログラム向け
- **sqlite**（実験的）: `sqlite3` バイナリが必要
- **postgres**（実験的）: `psql` と接続文字列が必要

注意事項:

- sqlite/postgres はオプトインで実験的です。
- postgres の認証情報はサブエージェントのログに流出します。専用の最小権限 DB を使用してください。

## リモートプログラム

`/prose run <handle/slug>` は `https://p.prose.md/<handle>/<slug>` に解決されます。
直接 URL はそのまま取得されます。これは `web_fetch` ツール（POST の場合は `exec`）を使用します。

## OpenClaw ランタイムマッピング

OpenProse のプログラムは OpenClaw のプリミティブにマッピングされます:

| OpenProse の概念            | OpenClaw のツール |
| ------------------------- | ---------------- |
| セッション生成 / Task ツール | `sessions_spawn` |
| ファイル読み書き             | `read` / `write` |
| Web フェッチ               | `web_fetch`      |

ツール許可リストがこれらのツールをブロックしている場合、OpenProse プログラムは失敗します。[Skills 設定](/tools/skills-config) を参照してください。

## セキュリティと承認

`.prose` ファイルはコードと同様に扱ってください。実行前にレビューしてください。OpenClaw のツール許可リストと承認ゲートを使用して副作用を制御してください。

決定論的で承認ゲート付きのワークフローについては、[Lobster](/tools/lobster) と比較してください。
