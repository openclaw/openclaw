---
summary: "OpenClaw のシステムプロンプトに含まれる内容と、その組み立て方法"
read_when:
  - システムプロンプトのテキスト、ツール一覧、または時間／ハートビートのセクションを編集する場合
  - ワークスペースのブートストラップや Skills の注入動作を変更する場合
title: "System Prompt"
---

# System Prompt

OpenClaw は、すべてのエージェント実行ごとにカスタムのシステムプロンプトを構築します。このプロンプトは **OpenClaw 管理**であり、p-coding-agent のデフォルトプロンプトは使用しません。 プロンプトは **OpenClaw-owned** で、p-coding-agent のデフォルトプロンプトは使用しません。

プロンプトは OpenClaw によって組み立てられ、各エージェント実行に注入されます。

## 構造

プロンプトは意図的にコンパクト化され、固定セクションを使用します:

- **Tooling**: 現在のツール一覧と簡潔な説明。
- **Safety**: 権力志向の行動や監視回避を避けるための短いガードレールの注意喚起。
- **Skills**（利用可能な場合）: Skills の指示をオンデマンドで読み込む方法をモデルに伝えます。
- **OpenClaw Self-Update**: `config.apply` と `update.run` の実行方法。
- **Workspace**: 作業ディレクトリ（`agents.defaults.workspace`）。
- **Documentation**: OpenClaw ドキュメントへのローカルパス（リポジトリまたは npm パッケージ）と、それを読むタイミング。
- **Workspace Files (injected)**: ブートストラップファイルが下部に含まれていることを示します。
- **Sandbox**（有効時）: サンドボックス化されたランタイム、サンドボックスのパス、昇格した exec が利用可能かどうかを示します。
- **Current Date & Time**: ユーザーのローカル時間、タイムゾーン、時刻形式。
- **Reply Tags**: 対応プロバイダー向けのオプションの返信タグ構文。
- **Heartbeats**: ハートビート用プロンプトと ack の動作。
- **Runtime**: ホスト、OS、node、モデル、リポジトリルート（検出時）、thinking レベル（1 行）。
- **Reasoning**: 現在の可視性レベルと /reasoning 切り替えのヒント。

システムプロンプトの安全ガードレールはアドバイザリーです。 彼らはモデルの動作をガイドしますが、ポリシーを強制しません。 ツールポリシー、exec 承認、サンドボックス化、チャネルによりハードエンフォースが許可されます。オペレータは設計上これらを無効にできます。

## Prompt modes

OpenClaw は、サブエージェント向けにより小さいシステムプロンプトをレンダリングできます。ランタイムは各実行ごとに
`promptMode` を設定します（ユーザー向け設定ではありません）。 ランタイムは実行ごとに
`promptMode` を設定します（ユーザー向けの設定ではありません）。

- `full`（デフォルト）: 上記のすべてのセクションを含みます。
- `minimal`: サブエージェント用。**Skills**、**Memory Recall**、**OpenClaw
  Self-Update**、**Model Aliases**、**User Identity**、**Reply Tags**、
  **Messaging**、**Silent Replies**、**Heartbeats** を省略します。Tooling、**Safety**、
  Workspace、Sandbox、Current Date & Time（判明している場合）、Runtime、および注入された
  コンテキストは引き続き利用可能です。 Tooling, **Safety** ,
  Workspace, Sandbox, Current Date & Time (When known), Runtime, and injected
  context available
- `none`: ベースの識別行のみを返します。

`promptMode=minimal` の場合、追加で注入されるプロンプトは **Group Chat Context** ではなく **Subagent
Context** としてラベル付けされます。

## Workspace bootstrap injection

ブートストラップファイルはトリミングされ、**Project Context** の下に追加されます。これにより、モデルは明示的な読み取りを行わなくても、アイデンティティとプロファイルのコンテキストを把握できます。

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`（新規作成されたワークスペースのみ）

大きなファイルはマーカーで切り捨てられます。 大きなファイルはマーカー付きで切り詰められます。ファイルごとの最大サイズは
`agents.defaults.bootstrapMaxChars`（デフォルト: 20000）で制御されます。欠落しているファイルは、短い欠落ファイルマーカーを注入します。 不足しているファイルは、
短い不足しているファイルマーカーを挿入します。

内部フックは `agent:bootstrap` を介してこのステップを横取りし、注入されるブートストラップファイルを変更または置換できます（例: `SOUL.md` を別のペルソナに差し替える）。

各注入ファイルがどれだけ寄与しているか（生データ vs 注入後、切り詰め、ツールスキーマのオーバーヘッドを含む）を確認するには、`/context list` または `/context detail` を使用してください。[Context](/concepts/context) を参照してください。 [Context](/concepts/context) を参照してください。

## Time handling

ユーザーのタイムゾーンが判明している場合、システムプロンプトには専用の **Current Date & Time** セクションが含まれます。プロンプトのキャッシュ安定性を保つため、現在は **タイムゾーン** のみを含み（動的な時計や時刻形式は含みません）。 プロンプトキャッシュの安定性を維持するために、今は **タイムゾーン**
のみを含みます (動的なクロックやタイムフォーマットは含まれません)。

エージェントが現在時刻を必要とする場合は `session_status` を使用してください。ステータスカードにはタイムスタンプ行が含まれます。

以下の設定：

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat`（`auto` | `12` | `24`）

詳細な動作については [Date & Time](/date-time) を参照してください。

## Skills

利用可能な Skills が存在する場合、OpenClaw は **available skills list** のコンパクトな一覧
（`formatSkillsForPrompt`）を注入し、各 Skill の **ファイルパス** を含めます。プロンプトは、一覧に記載された場所（ワークスペース、マネージド、またはバンドル）にある SKILL.md を読み込むために `read` を使用するようモデルに指示します。利用可能な Skills がない場合、Skills セクションは省略されます。
プロンプトは、モデルに `read` を使用して、リストされた
の場所(ワークスペース、管理されている、またはバンドルされている)で SKILL.md をロードするように指示します。 スキルがない場合は、
スキルセクションは省略されます。

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

これにより、ベースプロンプトを小さく保ちつつ、対象を絞った Skill の利用が可能になります。

## Documentation

利用可能な場合、システムプロンプトには **Documentation** セクションが含まれ、ローカルの OpenClaw ドキュメントディレクトリ（リポジトリワークスペース内の `docs/`、またはバンドルされた npm パッケージのドキュメント）を指し示します。また、公開ミラー、ソースリポジトリ、コミュニティ Discord、Skills 探索用の ClawHub（[https://clawhub.com](https://clawhub.com)）についても記載されます。プロンプトは、OpenClaw の動作、コマンド、設定、アーキテクチャについてはまずローカルドキュメントを参照するようモデルに指示し、可能な場合は `openclaw status` を自ら実行するよう求めます（アクセスできない場合のみユーザーに確認します）。 21. プロンプトは、OpenClaw の動作、コマンド、設定、またはアーキテクチャについて、まずローカルドキュメントを参照するようモデルに指示し、可能であれば `openclaw status` を自分で実行し（アクセスできない場合のみユーザーに尋ねる）ようにします。
