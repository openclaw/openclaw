---
read_when:
    - OpenClawにおける「コンテキスト」の意味を理解したい場合
    - モデルが何かを「知っている」（または忘れた）理由をデバッグしている場合
    - コンテキストのオーバーヘッドを削減したい場合（/context、/status、/compact）
summary: 'コンテキスト: モデルが参照する内容、その構築方法、確認方法'
title: コンテキスト
x-i18n:
    generated_at: "2026-04-02T07:37:27Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: a75b4cd65bf6385d46265b9ce1643310bc99d220e35ec4b4924096bed3ca4aa0
    source_path: concepts/context.md
    workflow: 15
---

# コンテキスト

「コンテキスト」とは、**OpenClawが1回の実行でモデルに送信するすべて**のことです。モデルの**コンテキストウィンドウ**（トークン制限）によって制約されます。

初心者向けメンタルモデル:

- **システムプロンプト**（OpenClawが構築）: ルール、ツール、Skills リスト、時刻/ランタイム、注入されたワークスペースファイル。
- **会話履歴**: このセッションにおけるあなたのメッセージ + アシスタントのメッセージ。
- **ツール呼び出し/結果 + 添付ファイル**: コマンド出力、ファイル読み取り、画像/音声など。

コンテキストは「メモリ」と_同じものではありません_。メモリはディスクに保存して後で再読み込みできますが、コンテキストはモデルの現在のウィンドウ内にあるものです。

## クイックスタート（コンテキストの確認）

- `/status` → 「ウィンドウはどのくらい埋まっているか？」のクイックビュー + セッション設定。
- `/context list` → 注入されている内容 + おおよそのサイズ（ファイルごと + 合計）。
- `/context detail` → より詳細な内訳: ファイルごと、ツールスキーマごと、Skills エントリごとのサイズ、およびシステムプロンプトサイズ。
- `/usage tokens` → 通常の返信にリプライごとの使用量フッターを追加。
- `/compact` → 古い履歴をコンパクトなエントリに要約してウィンドウスペースを解放。

参照: [スラッシュコマンド](/tools/slash-commands)、[トークン使用量とコスト](/reference/token-use)、[コンパクション](/concepts/compaction)。

## 出力例

値はモデル、プロバイダー、ツールポリシー、ワークスペースの内容によって異なります。

### `/context list`

```
🧠 Context breakdown
Workspace: <workspaceDir>
Bootstrap max/file: 20,000 chars
Sandbox: mode=non-main sandboxed=false
System prompt (run): 38,412 chars (~9,603 tok) (Project Context 23,901 chars (~5,976 tok))

Injected workspace files:
- AGENTS.md: OK | raw 1,742 chars (~436 tok) | injected 1,742 chars (~436 tok)
- SOUL.md: OK | raw 912 chars (~228 tok) | injected 912 chars (~228 tok)
- TOOLS.md: TRUNCATED | raw 54,210 chars (~13,553 tok) | injected 20,962 chars (~5,241 tok)
- IDENTITY.md: OK | raw 211 chars (~53 tok) | injected 211 chars (~53 tok)
- USER.md: OK | raw 388 chars (~97 tok) | injected 388 chars (~97 tok)
- HEARTBEAT.md: MISSING | raw 0 | injected 0
- BOOTSTRAP.md: OK | raw 0 chars (~0 tok) | injected 0 chars (~0 tok)

Skills list (system prompt text): 2,184 chars (~546 tok) (12 skills)
Tools: read, edit, write, exec, process, browser, message, sessions_send, …
Tool list (system prompt text): 1,032 chars (~258 tok)
Tool schemas (JSON): 31,988 chars (~7,997 tok) (counts toward context; not shown as text)
Tools: (same as above)

Session tokens (cached): 14,250 total / ctx=32,000
```

### `/context detail`

```
🧠 Context breakdown (detailed)
…
Top skills (prompt entry size):
- frontend-design: 412 chars (~103 tok)
- oracle: 401 chars (~101 tok)
… (+10 more skills)

Top tools (schema size):
- browser: 9,812 chars (~2,453 tok)
- exec: 6,240 chars (~1,560 tok)
… (+N more tools)
```

## コンテキストウィンドウにカウントされるもの

モデルが受け取るすべてがカウントされます。以下を含みます:

- システムプロンプト（すべてのセクション）。
- 会話履歴。
- ツール呼び出し + ツール結果。
- 添付ファイル/トランスクリプト（画像/音声/ファイル）。
- コンパクション要約とプルーニングアーティファクト。
- プロバイダーの「ラッパー」や隠しヘッダー（表示されないがカウントされる）。

## OpenClawがシステムプロンプトを構築する方法

システムプロンプトは**OpenClawが所有**し、実行ごとに再構築されます。以下を含みます:

- ツールリスト + 短い説明。
- Skills リスト（メタデータのみ。以下を参照）。
- ワークスペースの場所。
- 時刻（UTC + 設定されている場合は変換されたユーザー時刻）。
- ランタイムメタデータ（ホスト/OS/モデル/思考）。
- **Project Context** 配下に注入されたワークスペースブートストラップファイル。

詳細な内訳: [システムプロンプト](/concepts/system-prompt)。

## 注入されるワークスペースファイル（Project Context）

デフォルトでは、OpenClawは固定のワークスペースファイルセット（存在する場合）を注入します:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`（初回実行時のみ）

大きなファイルは `agents.defaults.bootstrapMaxChars`（デフォルト `20000` 文字）を使用してファイルごとに切り詰められます。OpenClawはまた、`agents.defaults.bootstrapTotalMaxChars`（デフォルト `150000` 文字）によりファイル全体のブートストラップ注入上限も適用します。`/context` は**生のサイズと注入後のサイズ**、および切り詰めが発生したかどうかを表示します。

切り詰めが発生した場合、ランタイムは Project Context 配下にプロンプト内警告ブロックを注入できます。これは `agents.defaults.bootstrapPromptTruncationWarning`（`off`、`once`、`always`。デフォルト `once`）で設定します。

## Skills: 注入されるものとオンデマンドで読み込まれるもの

システムプロンプトにはコンパクトな **Skills リスト**（名前 + 説明 + 場所）が含まれます。このリストには実際のオーバーヘッドがあります。

Skills の指示はデフォルトでは含まれ_ません_。モデルは**必要な場合にのみ** Skills の `SKILL.md` を `read` することが期待されています。

## ツール: 2つのコストがある

ツールは2つの方法でコンテキストに影響します:

1. システムプロンプト内の**ツールリストテキスト**（「Tooling」として表示されるもの）。
2. **ツールスキーマ**（JSON）。モデルがツールを呼び出せるようにモデルに送信されます。プレーンテキストとしては表示されませんが、コンテキストにカウントされます。

`/context detail` は最も大きなツールスキーマを分解表示するため、何が支配的かを確認できます。

## コマンド、ディレクティブ、「インラインショートカット」

スラッシュコマンドは Gateway ゲートウェイによって処理されます。いくつかの異なる動作があります:

- **スタンドアロンコマンド**: `/...` のみのメッセージはコマンドとして実行されます。
- **ディレクティブ**: `/think`、`/verbose`、`/reasoning`、`/elevated`、`/model`、`/queue` はモデルがメッセージを見る前に除去されます。
  - ディレクティブのみのメッセージはセッション設定を永続化します。
  - 通常のメッセージ内のインラインディレクティブはメッセージごとのヒントとして機能します。
- **インラインショートカット**（許可リストの送信者のみ）: 通常のメッセージ内の特定の `/...` トークンは即座に実行でき（例:「hey /status」）、残りのテキストがモデルに渡される前に除去されます。

詳細: [スラッシュコマンド](/tools/slash-commands)。

## セッション、コンパクション、プルーニング（何が永続化されるか）

メッセージ間で何が永続化されるかはメカニズムによって異なります:

- **通常の履歴**はポリシーによってコンパクション/プルーニングされるまでセッショントランスクリプトに永続化されます。
- **コンパクション**は要約をトランスクリプトに永続化し、最近のメッセージはそのまま保持します。
- **プルーニング**は実行の_インメモリ_プロンプトから古いツール結果を削除しますが、トランスクリプトは書き換えません。

ドキュメント: [セッション](/concepts/session)、[コンパクション](/concepts/compaction)、[セッションプルーニング](/concepts/session-pruning)。

デフォルトでは、OpenClawはアセンブリとコンパクションに組み込みの `legacy` コンテキストエンジンを使用します。`kind: "context-engine"` を提供するプラグインをインストールし、`plugins.slots.contextEngine` で選択すると、OpenClawはコンテキストのアセンブリ、`/compact`、および関連するサブエージェントコンテキストライフサイクルフックをそのエンジンに委譲します。`ownsCompaction: false` はレガシーエンジンへの自動フォールバックを行いません。アクティブなエンジンは `compact()` を正しく実装する必要があります。プラグイン可能なインターフェース、ライフサイクルフック、設定の詳細は[コンテキストエンジン](/concepts/context-engine)を参照してください。

## `/context` が実際に報告する内容

`/context` は利用可能な場合、最新の**実行時構築**システムプロンプトレポートを優先します:

- `System prompt (run)` = 最後の埋め込み（ツール対応）実行からキャプチャされ、セッションストアに永続化されたもの。
- `System prompt (estimate)` = 実行レポートが存在しない場合（またはレポートを生成しない CLI バックエンド経由で実行している場合）にその場で計算されたもの。

いずれの場合も、サイズと主要な要因を報告します。完全なシステムプロンプトやツールスキーマをダンプするものでは**ありません**。

## 関連

- [コンテキストエンジン](/concepts/context-engine) — プラグインによるカスタムコンテキスト注入
- [コンパクション](/concepts/compaction) — 長い会話の要約
- [システムプロンプト](/concepts/system-prompt) — システムプロンプトの構築方法
- [エージェントループ](/concepts/agent-loop) — エージェント実行サイクルの全体像
