---
read_when:
    - OpenClawが提供するツールについて理解したい場合
    - ツールの設定、許可、または拒否が必要な場合
    - 組み込みツール、Skills、プラグインのどれを使うか検討している場合
summary: 'OpenClawのツールとプラグインの概要: エージェントができることと拡張方法'
title: ツールとプラグイン
x-i18n:
    generated_at: "2026-04-02T07:56:00Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 1918da77faf547532b143810eb7001b979c1fe8f402984b668b92509197ff5cc
    source_path: tools/index.md
    workflow: 15
---

# ツールとプラグイン

エージェントがテキスト生成以外に行うすべての操作は**ツール**を通じて実行されます。
ツールは、エージェントがファイルを読み取り、コマンドを実行し、Webを閲覧し、
メッセージを送信し、デバイスとやり取りするための手段です。

## ツール、Skills、プラグイン

OpenClawには連携して動作する3つのレイヤーがあります:

<Steps>
  <Step title="ツールはエージェントが呼び出すもの">
    ツールは、エージェントが呼び出せる型付き関数です（例: `exec`、`browser`、
    `web_search`、`message`）。OpenClawには**組み込みツール**のセットが同梱されており、
    プラグインで追加のツールを登録できます。

    エージェントはツールをモデルAPIに送信される構造化された関数定義として認識します。

  </Step>

  <Step title="Skillsはエージェントにいつ・どのように行うかを教える">
    Skillsはシステムプロンプトに注入されるMarkdownファイル（`SKILL.md`）です。
    Skillsはエージェントにツールを効果的に使うためのコンテキスト、制約、
    ステップバイステップのガイダンスを提供します。Skillsはワークスペース、
    共有フォルダ、またはプラグイン内に配置できます。

    [Skillsリファレンス](/tools/skills) | [Skillsの作成](/tools/creating-skills)

  </Step>

  <Step title="プラグインはすべてをパッケージ化する">
    プラグインは、チャネル、モデルプロバイダー、ツール、Skills、音声、画像生成など、
    あらゆる機能の組み合わせを登録できるパッケージです。
    **コア**プラグイン（OpenClawに同梱）と**外部**プラグイン
    （コミュニティによりnpmで公開）があります。

    [プラグインのインストールと設定](/tools/plugin) | [独自プラグインの作成](/plugins/building-plugins)

  </Step>
</Steps>

## 組み込みツール

以下のツールはOpenClawに同梱されており、プラグインをインストールせずに利用できます:

| ツール                                  | 機能                                                     | ページ                                  |
| --------------------------------------- | -------------------------------------------------------- | --------------------------------------- |
| `exec` / `process`                      | シェルコマンドの実行、バックグラウンドプロセスの管理     | [Exec](/tools/exec)                     |
| `code_execution`                        | サンドボックス化されたリモートPython分析の実行           | [Code Execution](/tools/code-execution) |
| `browser`                               | Chromiumブラウザの操作（ナビゲーション、クリック、スクリーンショット） | [Browser](/tools/browser)               |
| `web_search` / `x_search` / `web_fetch` | Web検索、Xの投稿検索、ページコンテンツの取得            | [Web](/tools/web)                       |
| `read` / `write` / `edit`               | ワークスペース内のファイルI/O                            |                                         |
| `apply_patch`                           | 複数ハンクのファイルパッチ                               | [Apply Patch](/tools/apply-patch)       |
| `message`                               | すべてのチャネルでメッセージを送信                       | [Agent Send](/tools/agent-send)         |
| `canvas`                                | ノードCanvas の操作（表示、評価、スナップショット）      |                                         |
| `nodes`                                 | ペアリングされたデバイスの検出とターゲット指定           |                                         |
| `cron` / `gateway`                      | スケジュールジョブの管理、Gateway ゲートウェイの再起動   |                                         |
| `image` / `image_generate`              | 画像の分析または生成                                     |                                         |
| `sessions_*` / `agents_list`            | セッション管理、サブエージェント                         | [Sub-agents](/tools/subagents)          |

画像関連の作業では、分析には `image` を、生成や編集には `image_generate` を使用してください。`openai/*`、`google/*`、`fal/*`、またはその他のデフォルト以外の画像プロバイダーをターゲットにする場合は、まずそのプロバイダーの認証/APIキーを設定してください。

### プラグイン提供のツール

プラグインは追加のツールを登録できます。以下に例を示します:

- [Lobster](/tools/lobster) — 再開可能な承認機能を備えた型付きワークフローランタイム
- [LLM Task](/tools/llm-task) — 構造化出力のためのJSON専用LLMステップ
- [Diffs](/tools/diffs) — diffビューアーとレンダラー
- [OpenProse](/prose) — Markdownファーストのワークフローオーケストレーション

## ツールの設定

### 許可リストと拒否リスト

設定の `tools.allow` / `tools.deny` で、エージェントが呼び出せるツールを制御します。拒否は常に許可より優先されます。

```json5
{
  tools: {
    allow: ["group:fs", "browser", "web_search"],
    deny: ["exec"],
  },
}
```

### ツールプロファイル

`tools.profile` は `allow`/`deny` が適用される前のベース許可リストを設定します。
エージェントごとのオーバーライド: `agents.list[].tools.profile`。

| プロファイル | 含まれるもの                                |
| ----------- | ------------------------------------------- |
| `full`      | すべてのツール（デフォルト）                |
| `coding`    | ファイルI/O、ランタイム、セッション、メモリ、画像 |
| `messaging` | メッセージング、セッション一覧/履歴/送信/ステータス |
| `minimal`   | `session_status` のみ                       |

### ツールグループ

許可/拒否リストで `group:*` の省略形を使用できます:

| グループ           | ツール                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `group:runtime`    | exec, bash, process, code_execution                                                                       |
| `group:fs`         | read, write, edit, apply_patch                                                                            |
| `group:sessions`   | sessions_list, sessions_history, sessions_send, sessions_spawn, sessions_yield, subagents, session_status |
| `group:memory`     | memory_search, memory_get                                                                                 |
| `group:web`        | web_search, x_search, web_fetch                                                                           |
| `group:ui`         | browser, canvas                                                                                           |
| `group:automation` | cron, gateway                                                                                             |
| `group:messaging`  | message                                                                                                   |
| `group:nodes`      | nodes                                                                                                     |
| `group:openclaw`   | すべての組み込みOpenClawツール（プラグインツールを除く）                                                  |

### プロバイダー固有の制限

`tools.byProvider` を使用して、グローバルなデフォルトを変更せずに特定のプロバイダーのツールを制限できます:

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```
