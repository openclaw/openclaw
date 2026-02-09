---
summary: "OpenProse：OpenClaw における .prose ワークフロー、スラッシュコマンド、状態管理"
read_when:
  - .prose ワークフローを実行または作成したい場合
  - OpenProse プラグインを有効化したい場合
  - 状態ストレージを理解する必要がある場合
title: "OpenProse"
---

# OpenProse

OpenProse は、AI セッションをオーケストレーションするための、ポータブルで Markdown ファーストなワークフローフォーマットです。OpenClaw では、OpenProse の Skill パックと `/prose` スラッシュコマンドをインストールするプラグインとして提供されます。プログラムは `.prose` ファイルに配置され、明示的な制御フローにより複数のサブエージェントを生成できます。 OpenClawでは、OpenProseのスキルパックにスラッシュコマンドを加えたプラグインとして出荷されます。 プログラムは `.prose` ファイルに含まれており、明示的な制御フローを持つ複数のサブエージェントを生成できます。

公式サイト: [https://www.prose.md](https://www.prose.md)

## できること

- 明示的な並列性を備えた、マルチエージェントによる調査と統合。
- 再現可能で承認安全なワークフロー（コードレビュー、インシデントトリアージ、コンテンツパイプライン）。
- 対応するエージェントランタイム間で実行できる、再利用可能な `.prose` プログラム。

## インストールと有効化

バンドルされたプラグインはデフォルトで無効になっています。 OpenProseを有効にする

```bash
openclaw plugins enable open-prose
```

プラグインを有効化した後、Gateway（ゲートウェイ）を再起動してください。

開発／ローカルチェックアウト: `openclaw plugins install ./extensions/open-prose`

関連ドキュメント: [Plugins](/tools/plugin)、[Plugin manifest](/plugins/manifest)、[Skills](/tools/skills)。

## スラッシュコマンド

OpenProse は `/prose` をユーザーが呼び出すことのできるskill コマンドとして登録します。 OpenProse は、ユーザーが呼び出せる Skill コマンドとして `/prose` を登録します。これは OpenProse VM の命令にルーティングされ、内部で OpenClaw のツールを使用します。

一般的なコマンド:

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

## ファイルの配置場所

OpenProse は、ワークスペース内の `.prose/` 配下に状態を保持します。

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

ユーザーレベルの永続エージェントは次の場所に配置されます。

```
~/.prose/agents/
```

## 状態モード

OpenProse は複数の状態バックエンドをサポートします。

- **filesystem**（デフォルト）: `.prose/runs/...`
- **in-context**: 小規模なプログラム向けの一時的な方式
- **sqlite**（実験的）: `sqlite3` バイナリが必要
- **postgres**（実験的）: `psql` と接続文字列が必要

注記:

- sqlite／postgres はオプトインで、実験的です。
- postgres の資格情報はサブエージェントのログに流れます。専用で最小権限の DB を使用してください。

## リモートプログラム

`/prose run <handle/slug>` は `https://p.prose.md/<handle>/<slug>` に解決されます。
直接 URL はそのまま取得されます。これは `web_fetch` ツール（POST の場合は `exec`）を使用します。
直接 URL はそのまま取得されます。 これは `web_fetch` ツール (POST は `exec` ) を使用します。

## OpenClaw ランタイムの対応関係

OpenProse プログラムは OpenClaw のプリミティブにマッピングされます。

| OpenProse の概念  | OpenClaw のツール    |
| -------------- | ---------------- |
| セッション生成／タスクツール | `sessions_spawn` |
| ファイルの読み書き      | `read` / `write` |
| Web 取得         | `web_fetch`      |

ツールの許可リストがこれらのツールをブロックしている場合、OpenProse プログラムは失敗します。[Skills config](/tools/skills-config) を参照してください。 [スキル設定](/tools/skills-config)を参照してください。

## セキュリティと承認

`.prose`ファイルをコードのように扱います。 実行する前にレビューしてください。 OpenClawツールを使用すると副作用を制御するために許可リストと承認ゲートを使用します。

決定的で承認ゲート付きのワークフローについては、[Lobster](/tools/lobster) と比較してください。
