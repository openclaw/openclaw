---
summary: "コンテキスト：モデルが何を見るか、どのように構築され、どのように検査するか"
read_when:
  - OpenClaw における「コンテキスト」の意味を理解したい場合
  - モデルがなぜ何かを「知っている」のか（または忘れたのか）をデバッグしている場合
  - コンテキストのオーバーヘッドを削減したい場合（/context、/status、/compact）
title: "コンテキスト"
---

# コンテキスト

「コンテキスト」とは、**1 回の実行のために OpenClaw がモデルへ送信するすべて**を指します。これはモデルの **コンテキストウィンドウ**（トークン上限）によって制限されます。 モデルの **コンテキストウィンドウ** (トークン制限) に囲まれています。

初心者向けのメンタルモデル：

- **システムプロンプト**（OpenClaw が構築）：ルール、ツール、Skills の一覧、時刻／ランタイム情報、注入されたワークスペースファイル。
- **会話履歴**：このセッションにおけるあなたのメッセージとアシスタントのメッセージ。
- **ツール呼び出し／結果 + 添付**：コマンド出力、ファイル読み取り、画像／音声など。

コンテキストは「メモリ」とは _同じではありません_。メモリはディスクに保存して後で再読み込みできますが、コンテキストはモデルの現在のウィンドウ内にあるものです。

## クイックスタート（コンテキストの確認）

- `/status` → 「ウィンドウがどのくらい埋まっているか」を素早く確認する表示 + セッション設定。
- `/context list` → 注入されているものと概算サイズ（ファイルごと + 合計）。
- `/context detail` → より詳細な内訳：ファイルごと、ツールスキーマごとのサイズ、Skills エントリーごとのサイズ、システムプロンプトサイズ。
- `/usage tokens` → 通常の返信に、返信ごとの使用量フッターを付加。
- `/compact` → 古い履歴を要約してコンパクトなエントリーにし、ウィンドウ空間を解放。

関連項目： [Slash commands](/tools/slash-commands)、[Token use & costs](/reference/token-use)、[Compaction](/concepts/compaction)。

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

## コンテキストウィンドウに含まれるもの

モデルが受信するものはすべてカウントされます。これには以下が含まれます。

- システムプロンプト（すべてのセクション）。
- 会話履歴。
- ツール呼び出し + ツール結果。
- 添付／トランスクリプト（画像／音声／ファイル）。
- コンパクションの要約およびプルーニングの成果物。
- プロバイダーの「ラッパー」や隠しヘッダー（表示されなくてもカウントされます）。

## OpenClaw によるシステムプロンプトの構築方法

システムプロンプトは **OpenClaw 管理**であり、実行ごとに再構築されます。内容は次のとおりです。 これには以下が含まれます：

- ツール一覧 + 短い説明。
- Skills の一覧（メタデータのみ。下記参照）。
- ワークスペースの場所。
- 時刻（UTC + 設定されている場合は変換後のユーザー時刻）。
- ランタイムメタデータ（ホスト／OS／モデル／thinking）。
- **Project Context** 配下に注入されるワークスペースのブートストラップファイル。

完全な内訳： [System Prompt](/concepts/system-prompt)。

## 注入されるワークスペースファイル（Project Context）

デフォルトでは、OpenClaw は次の固定セットのワークスペースファイル（存在する場合）を注入します。

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`（初回実行時のみ）

大きなファイルは、ファイルごとに `agents.defaults.bootstrapMaxChars` を用いて切り詰められます（デフォルトは `20000` 文字）。`/context` では **生サイズと注入後サイズ**、および切り詰めが発生したかどうかが表示されます。 `/context` は **raw vs injected** サイズと切り捨てが発生したかどうかを示します。

## Skills：注入されるものとオンデマンドで読み込まれるもの

システムプロンプトには、コンパクトな **Skills 一覧**（名前 + 説明 + 場所）が含まれます。この一覧には実際のオーバーヘッドがあります。 このリストには実際のオーバーヘッドがあります。

スキルの説明はデフォルトでは含まれていません。 Skill の指示内容は、デフォルトでは含まれません。モデルは、必要な場合にのみ、その Skill の `SKILL.md` を `read` することが想定されています。

## ツール：2 種類のコスト

ツールは、コンテキストに対して 2 つの形で影響します。

1. システムプロンプト内の **ツール一覧テキスト**（「Tooling」として見える部分）。
2. **ツールスキーマ**（JSON）。モデルがツールを呼び出せるよう送信されます。平文としては見えませんが、コンテキストにカウントされます。 これらは、ツールを呼び出すことができるように、モデルに送信されます。 プレーンテキストとして表示されていないにもかかわらず、コンテキストに向かってカウントされます。

`/context detail` では、最も大きなツールスキーマの内訳が示され、何が支配的かを確認できます。

## コマンド、ディレクティブ、「インラインショートカット」

スラッシュコマンドは Gateway（ゲートウェイ）によって処理されます。いくつかの異なる挙動があります。 いくつかの異なる動作があります。

- **スタンドアロンコマンド**：メッセージが `/...` のみの場合、コマンドとして実行されます。
- **ディレクティブ**：`/think`、`/verbose`、`/reasoning`、`/elevated`、`/model`、`/queue` は、モデルがメッセージを見る前に取り除かれます。
  - ディレクティブのみのメッセージは、セッション設定を永続化します。
  - 通常メッセージ内のインラインディレクティブは、メッセージ単位のヒントとして機能します。
- **インラインショートカット**（許可リストに含まれる送信者のみ）：通常メッセージ内の特定の `/...` トークンは即座に実行できます（例：「hey /status」）。その後、残りのテキストがモデルに渡る前に取り除かれます。

詳細： [Slash commands](/tools/slash-commands)。

## セッション、コンパクション、プルーニング（何が永続化されるか）

メッセージ間で何が永続化されるかは、仕組みによって異なります。

- **通常の履歴**：ポリシーによりコンパクト化／プルーニングされるまで、セッションのトランスクリプトに残ります。
- **コンパクション**：要約をトランスクリプトに永続化し、直近のメッセージはそのまま保持します。
- **プルーニング**：実行時の _インメモリ_ プロンプトから古いツール結果を削除しますが、トランスクリプトは書き換えません。

ドキュメント： [Session](/concepts/session)、[Compaction](/concepts/compaction)、[Session pruning](/concepts/session-pruning)。

## `/context` が実際に報告する内容

`/context` は、利用可能な場合、最新の **実行時に構築された** システムプロンプトのレポートを優先します。

- `System prompt (run)` = 最後の埋め込み（ツール対応）実行から取得され、セッションストアに永続化されたもの。
- `System prompt (estimate)` = 実行レポートが存在しない場合（またはレポートを生成しない CLI バックエンド経由で実行した場合）に、その場で計算されたもの。

いずれの場合も、サイズと主な寄与要因を報告しますが、完全なシステムプロンプトやツールスキーマをダンプすることは **ありません**。
