---
title: "コンテキスト"
summary: "コンテキスト: モデルが見るもの、その構築方法、検査方法"
read_when:
  - You want to understand what "context" means in OpenClaw
  - You are debugging why the model "knows" something (or forgot it)
  - You want to reduce context overhead (/context, /status, /compact)
---

# コンテキスト

「コンテキスト」とは、**OpenClawが1回の実行でモデルに送信するすべてのもの**です。モデルの**コンテキストウィンドウ**（トークン制限）によって制約されます。

初心者向けのメンタルモデル:

- **システムプロンプト**（OpenClawが構築）: ルール、ツール、スキルリスト、時間/ランタイム、注入されたワークスペースファイル。
- **会話履歴**: このセッションのあなたのメッセージ + アシスタントのメッセージ。
- **ツール呼び出し/結果 + 添付ファイル**: コマンド出力、ファイル読み取り、画像/音声など。

コンテキストは「メモリ」と_同じものではありません_。メモリはディスクに保存して後で再読み込みできます。コンテキストはモデルの現在のウィンドウ内にあるものです。

## クイックスタート（コンテキストの検査）

- `/status` → 「ウィンドウの使用率」のクイックビュー + セッション設定。
- `/context list` → 注入されたもの + おおまかなサイズ（ファイルごと + 合計）。
- `/context detail` → より詳細な内訳: ファイルごと、ツールスキーマサイズごと、スキルエントリサイズごと、システムプロンプトサイズ。
- `/usage tokens` → 通常の返信に返信ごとの使用量フッターを追加。
- `/compact` → 古い履歴をコンパクトエントリに要約してウィンドウスペースを解放。

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

モデルが受け取るすべてのものがカウントされます:

- システムプロンプト（すべてのセクション）。
- 会話履歴。
- ツール呼び出し + ツール結果。
- 添付ファイル/トランスクリプト（画像/音声/ファイル）。
- コンパクションサマリーとプルーニングアーティファクト。
- プロバイダーの「ラッパー」や非表示ヘッダー（見えませんが、カウントされます）。

## OpenClawがシステムプロンプトを構築する方法

システムプロンプトは**OpenClawが所有**し、各実行ごとに再構築されます。含まれるもの:

- ツールリスト + 短い説明。
- スキルリスト（メタデータのみ。以下参照）。
- ワークスペースの場所。
- 時間（UTC + 設定されている場合はユーザーの変換時間）。
- ランタイムメタデータ（ホスト/OS/モデル/thinking）。
- **Project Context**配下に注入されたワークスペースブートストラップファイル。

完全な内訳: [システムプロンプト](/concepts/system-prompt)。

## 注入されたワークスペースファイル（Project Context）

デフォルトでは、OpenClawは固定セットのワークスペースファイル（存在する場合）を注入します:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`（初回実行時のみ）

大きなファイルは`agents.defaults.bootstrapMaxChars`（デフォルト`20000`文字）でファイルごとに切り詰められます。OpenClawはまた、`agents.defaults.bootstrapTotalMaxChars`（デフォルト`150000`文字）でファイル全体のブートストラップ注入合計キャップも適用します。`/context`は**生のサイズ vs 注入されたサイズ**と切り詰めが発生したかどうかを表示します。

## スキル: 注入されるもの vs オンデマンドで読み込まれるもの

システムプロンプトにはコンパクトな**スキルリスト**（名前 + 説明 + 場所）が含まれます。このリストには実際のオーバーヘッドがあります。

スキルの指示はデフォルトでは含まれ_ません_。モデルは**必要な場合にのみ**スキルの`SKILL.md`を`read`することが期待されています。

## ツール: 2つのコスト

ツールはコンテキストに2つの方法で影響します:

1. システムプロンプト内の**ツールリストテキスト**（「Tooling」として表示されるもの）。
2. **ツールスキーマ**（JSON）。これらはモデルがツールを呼び出せるようにモデルに送信されます。プレーンテキストとして表示されなくてもコンテキストにカウントされます。

`/context detail`は最大のツールスキーマを分解して、何が支配的かを確認できます。

## コマンド、ディレクティブ、「インラインショートカット」

スラッシュコマンドはGatewayによって処理されます。いくつかの異なる動作があります:

- **スタンドアロンコマンド**: `/...`のみのメッセージはコマンドとして実行されます。
- **ディレクティブ**: `/think`、`/verbose`、`/reasoning`、`/elevated`、`/model`、`/queue`はモデルがメッセージを見る前に除去されます。
  - ディレクティブのみのメッセージはセッション設定を永続化します。
  - 通常のメッセージ内のインラインディレクティブはメッセージごとのヒントとして機能します。
- **インラインショートカット**（許可された送信者のみ）: 通常のメッセージ内の特定の`/...`トークンは即座に実行でき（例: 「hey /status」）、モデルが残りのテキストを見る前に除去されます。

詳細: [スラッシュコマンド](/tools/slash-commands)。

## セッション、コンパクション、プルーニング（何が永続化されるか）

メッセージ間で何が永続化されるかはメカニズムによって異なります:

- **通常の履歴**はコンパクション/プルーニングポリシーによって処理されるまでセッションのトランスクリプトに永続化されます。
- **コンパクション**はサマリーをトランスクリプトに永続化し、最近のメッセージはそのまま保持します。
- **プルーニング**は実行の_インメモリ_プロンプトから古いツール結果を削除しますが、トランスクリプトを書き換えません。

ドキュメント: [セッション](/concepts/session)、[コンパクション](/concepts/compaction)、[セッションプルーニング](/concepts/session-pruning)。

## `/context`が実際に報告するもの

`/context`は利用可能な場合、最新の**実行時に構築された**システムプロンプトレポートを優先します:

- `System prompt (run)` = 最後の組み込み（ツール対応）実行からキャプチャされ、セッションストアに永続化されます。
- `System prompt (estimate)` = 実行レポートが存在しない場合（またはレポートを生成しないCLIバックエンド経由で実行する場合）にその場で計算されます。

いずれの場合もサイズと主要な貢献者を報告します。完全なシステムプロンプトやツールスキーマをダンプすることは**ありません**。
