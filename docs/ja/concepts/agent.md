---
summary: "エージェント ランタイム（埋め込み pi-mono）、ワークスペース契約、セッション ブートストラップ"
read_when:
  - エージェント ランタイム、ワークスペースのブートストラップ、またはセッションの挙動を変更する場合
title: "エージェント ランタイム"
---

# エージェント ランタイム 🤖

OpenClaw は **pi-mono** から派生した、単一の埋め込みエージェント ランタイムを実行します。

## ワークスペース（必須）

OpenClaw は、エージェントの **唯一** の作業ディレクトリ（`cwd`）として、単一のエージェント ワークスペース ディレクトリ（`agents.defaults.workspace`）を使用し、ツールとコンテキストを管理します。

推奨: `openclaw setup` を使用して、存在しない場合は `~/.openclaw/openclaw.json` を作成し、ワークスペース ファイルを初期化します。

ワークスペースの完全なレイアウト + バックアップ ガイド: [Agent workspace](/concepts/agent-workspace)

`agents.defaults.sandbox` が有効な場合、非メイン セッションは `agents.defaults.sandbox.workspaceRoot` 配下のセッションごとのワークスペースでこれを上書きできます（[Gateway configuration](/gateway/configuration) を参照）。

## ブートストラップ ファイル（注入）

`agents.defaults.workspace` 内で、OpenClaw は次のユーザー編集可能なファイルを想定します。

- `AGENTS.md` — 運用指示 + 「メモリー」
- `SOUL.md` — ペルソナ、境界、トーン
- `TOOLS.md` — ユーザー管理のツール ノート（例: `imsg`、`sag`、規約）
- `BOOTSTRAP.md` — 初回実行時の一度きりのリチュアル（完了後に削除）
- `IDENTITY.md` — エージェント名／雰囲気／絵文字
- `USER.md` — ユーザー プロファイル + 希望する呼称

新しいセッションの最初のターンで、OpenClaw はこれらのファイル内容をエージェント コンテキストに直接注入します。

空白のファイルはスキップされます。 空のファイルはスキップされます。大きなファイルは、プロンプトを簡潔に保つため、マーカー付きでトリムおよび切り詰められます（完全な内容はファイルを参照してください）。

ファイルが存在しない場合、OpenClaw は単一の「missing file」マーカー行を注入します（そして `openclaw setup` が安全な既定テンプレートを作成します）。

`BOOTSTRAP.md` は **まったく新しいワークスペース**（他のブートストラップ ファイルが存在しない）の場合にのみ作成されます。リチュアル完了後に削除した場合、以降の再起動で再作成されることはありません。 儀式を完了した後に削除した場合は、後で再起動しないでください。

ブートストラップ ファイルの作成を完全に無効化する（事前にシードされたワークスペース向け）には、次を設定します。

```json5
{ agent: { skipBootstrap: true } }
```

## 組み込みツール

13. コアツール（read/exec/edit/write および関連するシステムツール）は、ツールポリシーに従って常に利用可能です。 コア ツール（read/exec/edit/write および関連するシステム ツール）は、ツール ポリシーに従い、常に利用可能です。`apply_patch` は任意で、`tools.exec.applyPatch` によりゲートされます。`TOOLS.md` は、どのツールが存在するかを制御するものではありません。これは、ツールをどのように使ってほしいかという _あなた_ 向けのガイダンスです。 14. `TOOLS.md` はどのツールが存在するかを制御するものではありません。これは、それらをどのように使ってほしいかについての _あなた_ 向けのガイダンスです。

## Skills

OpenClaw は 3 つの場所から Skills を読み込みます（同名競合時はワークスペースが優先されます）。

- バンドル（インストールに同梱）
- 管理／ローカル: `~/.openclaw/skills`
- ワークスペース: `<workspace>/skills`

Skills は config／環境変数によりゲートできます（[Gateway configuration](/gateway/configuration) の `skills` を参照）。

## pi-mono 連携

OpenClaw は pi-mono のコードベース（モデル／ツール）の一部を再利用しますが、**セッション管理、ディスカバリー、ツール配線は OpenClaw 独自** です。

- pi-coding エージェント ランタイムはありません。
- `~/.pi/agent` や `<workspace>/.pi` の設定は参照されません。

## セッション

セッションのトランスクリプトは、次の場所に JSONL として保存されます。

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

セッション ID は安定しており、OpenClawによって選択されます。
セッション ID は安定しており、OpenClaw が選択します。
従来の Pi/Tau セッション フォルダーは **読み取られません**。

## ストリーミング中のステアリング

キューモードが `steer` の場合、現在の実行にメッセージを入力します。
キュー モードが `steer` の場合、受信メッセージは現在の実行に注入されます。
キューは **各ツール呼び出し後** に確認されます。キュー済みメッセージが存在する場合、現在のアシスタント メッセージからの残りのツール呼び出しはスキップされ（「Skipped due to queued user message.」というエラー ツール結果）、次のアシスタント応答の前にキュー済みユーザー メッセージが注入されます。

キュー モードが `followup` または `collect` の場合、受信メッセージは現在のターンが終了するまで保持され、その後キューされたペイロードで新しいエージェント ターンが開始されます。モードおよびデバウンス／キャップの挙動については [Queue](/concepts/queue) を参照してください。 モード + debounce/cap の動作については
[Queue](/concepts/queue) を参照してください。

ブロック ストリーミングは、完了したアシスタント ブロックを完了次第送信します。既定では **オフ** です（`agents.defaults.blockStreamingDefault: "off"`）。
境界は `agents.defaults.blockStreamingBreak`（`text_end` と `message_end` の比較。既定は text_end）で調整します。
ソフト ブロックのチャンク化は `agents.defaults.blockStreamingChunk` で制御します（既定は 800–1200 文字。段落区切りを優先し、次に改行、文は最後）。
ストリーミングされたチャンクは `agents.defaults.blockStreamingCoalesce` で結合し、単一行スパムを削減します（送信前のアイドル ベース結合）。
Telegram 以外のチャンネルでは、ブロック返信を有効化するために明示的な `*.blockStreaming: true` が必要です。
詳細なツール サマリーはツール開始時に出力されます（デバウンスなし）。Control UI は、利用可能な場合、エージェント イベントを通じてツール出力をストリームします。
詳細: [Streaming + chunking](/concepts/streaming)。
`agents.defaults.blockStreamingBreak` (`text_end` vs `message_end` ; デフォルトは text_end です) で境界を調整します。
`agents.defaults.blockStreamingChunk` （デフォルトは
800–1200 文字。段落区切り、改行、文章続き） でソフトブロックのチャンキングを制御します。
Coalesceは`agents.defaults.blockStreamingCoalesce`でチャンクをストリーミングし、
単一行のスパムを減らしました（送信前にアイドルベースのマージ）。 15. Telegram 以外のチャンネルでは、ブロック返信を有効にするために明示的に `*.blockStreaming: true` が必要です。
詳細なツールサマリはツール開始時に出力されます(デバウンスなし); Control UI
は、利用可能な場合、エージェントイベントを介してツール出力をストリームします。
詳細: [ストリーミング + チャンキング](/concepts/streaming)。

## モデル参照

config 内のモデル参照（例: `agents.defaults.model` および `agents.defaults.models`）は、**最初の** `/` で分割して解析されます。

- モデルを設定する際は `provider/model` を使用してください。
- モデル ID 自体に `/`（OpenRouter 形式）が含まれる場合は、プロバイダー接頭辞を含めてください（例: `openrouter/moonshotai/kimi-k2`）。
- プロバイダーを省略した場合、OpenClaw は入力をエイリアス、または **既定プロバイダー** のモデルとして扱います（モデル ID に `/` が含まれない場合にのみ有効）。

## 設定（最小）

最低限、次を設定してください。

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom`（強く推奨）

---

_次へ: [Group Chats](/channels/group-messages)_ 🦞
