---
read_when:
    - システムプロンプトのテキスト、ツールリスト、時刻/ハートビートセクションを編集する場合
    - ワークスペースのブートストラップや Skills インジェクション動作を変更する場合
summary: OpenClawのシステムプロンプトの内容と組み立て方法
title: システムプロンプト
x-i18n:
    generated_at: "2026-04-02T07:40:29Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: ffeca4599981ad6da0d293a8c72420e6dd2e1bc931a915c83e30865d5b986023
    source_path: concepts/system-prompt.md
    workflow: 15
---

# システムプロンプト

OpenClawはエージェント実行ごとにカスタムシステムプロンプトを構築します。このプロンプトは**OpenClaw独自のもの**であり、pi-coding-agentのデフォルトプロンプトは使用しません。

プロンプトはOpenClawによって組み立てられ、各エージェント実行に注入されます。

## 構造

プロンプトは意図的にコンパクトで、固定セクションを使用します：

- **Tooling**: 現在のツールリストと短い説明。
- **Safety**: パワーシーキング行動や監視の回避を防ぐための短いガードレールリマインダー。
- **Skills**（利用可能な場合）: オンデマンドで Skills の指示を読み込む方法をモデルに伝えます。
- **OpenClaw Self-Update**: `config.apply` と `update.run` の実行方法。
- **Workspace**: 作業ディレクトリ（`agents.defaults.workspace`）。
- **Documentation**: OpenClawドキュメントのローカルパス（リポジトリまたはnpmパッケージ）と参照タイミング。
- **Workspace Files (injected)**: ブートストラップファイルが以下に含まれていることを示します。
- **サンドボックス**（有効な場合）: サンドボックス化されたランタイム、サンドボックスパス、昇格実行が利用可能かどうかを示します。
- **Current Date & Time**: ユーザーのローカル時刻、タイムゾーン、時刻形式。
- **Reply Tags**: 対応プロバイダー向けのオプションのリプライタグ構文。
- **Heartbeats**: ハートビートプロンプトとackの動作。
- **Runtime**: ホスト、OS、node、モデル、リポジトリルート（検出された場合）、思考レベル（1行）。
- **Reasoning**: 現在の可視性レベルと /reasoning トグルのヒント。

システムプロンプト内のセーフティガードレールはアドバイザリーです。モデルの動作をガイドしますが、ポリシーを強制するものではありません。ハードな強制にはツールポリシー、実行承認、サンドボックス化、チャネル許可リストを使用してください。オペレーターは設計上これらを無効にできます。

## プロンプトモード

OpenClawはサブエージェント向けに小さなシステムプロンプトをレンダリングできます。ランタイムは各実行に対して`promptMode`を設定します（ユーザー向けの設定ではありません）：

- `full`（デフォルト）: 上記のすべてのセクションを含みます。
- `minimal`: サブエージェントに使用されます。**Skills**、**Memory Recall**、**OpenClaw
  Self-Update**、**Model Aliases**、**User Identity**、**Reply Tags**、
  **Messaging**、**Silent Replies**、**Heartbeats**を省略します。Tooling、**Safety**、
  Workspace、サンドボックス、Current Date & Time（判明している場合）、Runtime、注入された
  コンテキストは引き続き利用可能です。
- `none`: ベースのアイデンティティ行のみを返します。

`promptMode=minimal`の場合、追加の注入プロンプトは**Group Chat Context**ではなく**Subagent
Context**とラベル付けされます。

## ワークスペースブートストラップの注入

ブートストラップファイルはトリミングされ、**Project Context**の下に追加されるため、モデルは明示的な読み取りなしにアイデンティティとプロファイルのコンテキストを確認できます：

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`（新規ワークスペースの場合のみ）
- `MEMORY.md`（存在する場合）、それ以外は小文字のフォールバックとして`memory.md`

これらのファイルはすべて毎ターン**コンテキストウィンドウに注入**されるため、
トークンを消費します。特に`MEMORY.md`は時間とともに大きくなり、予期せず高い
コンテキスト使用量やより頻繁なコンパクションにつながる可能性があるため、
簡潔に保ってください。

> **注意:** `memory/*.md`のデイリーファイルは自動的には**注入されません**。
> `memory_search`および`memory_get`ツールを介してオンデマンドでアクセスされるため、
> モデルが明示的に読み取らない限り、コンテキストウィンドウにカウントされません。

大きなファイルはマーカー付きで切り詰められます。ファイルごとの最大サイズは
`agents.defaults.bootstrapMaxChars`（デフォルト: 20000）で制御されます。ファイル全体の
注入ブートストラップコンテンツの合計は`agents.defaults.bootstrapTotalMaxChars`
（デフォルト: 150000）で上限が設定されます。存在しないファイルは短いmissing-fileマーカーを
注入します。切り詰めが発生した場合、OpenClawはProject Context内に警告ブロックを注入
できます。これは`agents.defaults.bootstrapPromptTruncationWarning`（`off`、`once`、`always`、
デフォルト: `once`）で制御します。

サブエージェントセッションは`AGENTS.md`と`TOOLS.md`のみを注入します（サブエージェントの
コンテキストを小さく保つため、他のブートストラップファイルはフィルタリングされます）。

内部フックは`agent:bootstrap`を介してこのステップをインターセプトし、注入される
ブートストラップファイルを変更または置換できます（例：`SOUL.md`を別のペルソナに差し替える）。

各注入ファイルの貢献度（生データ vs 注入後、切り詰め、およびツールスキーマのオーバーヘッド）を確認するには、`/context list`または`/context detail`を使用してください。[コンテキスト](/concepts/context)を参照してください。

## 時刻の処理

システムプロンプトには、ユーザーのタイムゾーンが判明している場合、専用の**Current Date & Time**
セクションが含まれます。プロンプトキャッシュの安定性を保つため、現在は**タイムゾーン**のみが
含まれます（動的な時計や時刻形式は含まれません）。

エージェントが現在時刻を必要とする場合は`session_status`を使用してください。ステータスカードに
タイムスタンプ行が含まれています。

以下で設定します：

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat`（`auto` | `12` | `24`）

動作の詳細は[日付と時刻](/date-time)を参照してください。

## Skills

対象となる Skills が存在する場合、OpenClawは各 Skills の**ファイルパス**を含むコンパクトな
**利用可能な Skills リスト**（`formatSkillsForPrompt`）を注入します。プロンプトは、
リストされた場所（ワークスペース、マネージド、またはバンドル）のSKILL.mdを`read`で
読み込むようモデルに指示します。対象となる Skills がない場合、Skillsセクションは省略されます。

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

これにより、ベースプロンプトを小さく保ちながら、対象を絞った Skills の使用が可能になります。

## ドキュメント

利用可能な場合、システムプロンプトにはローカルのOpenClawドキュメントディレクトリ（リポジトリ
ワークスペースの`docs/`またはバンドルされたnpmパッケージのドキュメント）を指す
**Documentation**セクションが含まれ、パブリックミラー、ソースリポジトリ、コミュニティDiscord、
Skills ディスカバリー用のClawHub（[https://clawhub.com](https://clawhub.com)）も記載されます。プロンプトは、OpenClawの動作、
コマンド、設定、アーキテクチャについてはまずローカルドキュメントを参照し、可能な場合は
自分で`openclaw status`を実行するよう（アクセスできない場合のみユーザーに確認するよう）
モデルに指示します。
