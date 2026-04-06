---
read_when:
    - エージェントランタイム、ワークスペースブートストラップ、またはセッション動作を変更する場合
summary: エージェントランタイム、ワークスペース契約、およびセッションブートストラップ
title: エージェントランタイム
x-i18n:
    generated_at: "2026-04-02T07:36:41Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 1e26d692707903d19ae41663f0341eab9cf8266a4883ec73549aec22f4583492
    source_path: concepts/agent.md
    workflow: 15
---

# エージェントランタイム

OpenClaw は単一の組み込みエージェントランタイムを実行します。

## ワークスペース（必須）

OpenClaw は単一のエージェントワークスペースディレクトリ（`agents.defaults.workspace`）をエージェントの**唯一の**作業ディレクトリ（`cwd`）としてツールとコンテキストに使用します。

推奨: `~/.openclaw/openclaw.json` が存在しない場合は `openclaw setup` を使用して作成し、ワークスペースファイルを初期化してください。

ワークスペースの完全なレイアウトとバックアップガイド: [エージェントワークスペース](/concepts/agent-workspace)

`agents.defaults.sandbox` が有効な場合、メイン以外のセッションは `agents.defaults.sandbox.workspaceRoot` 配下のセッションごとのワークスペースでこれをオーバーライドできます（[Gateway ゲートウェイ設定](/gateway/configuration)を参照）。

## ブートストラップファイル（注入）

`agents.defaults.workspace` 内で、OpenClaw は以下のユーザー編集可能なファイルを期待します:

- `AGENTS.md` — 操作指示と「記憶」
- `SOUL.md` — ペルソナ、境界、トーン
- `TOOLS.md` — ユーザーが管理するツールメモ（例: `imsg`、`sag`、規約）
- `BOOTSTRAP.md` — 初回実行時の儀式（完了後に削除）
- `IDENTITY.md` — エージェント名/雰囲気/絵文字
- `USER.md` — ユーザープロフィールと呼び方の設定

新しいセッションの最初のターンで、OpenClaw はこれらのファイルの内容をエージェントコンテキストに直接注入します。

空のファイルはスキップされます。大きなファイルはトリミングおよび切り詰められ、プロンプトが軽量に保たれるようマーカーが付与されます（完全な内容はファイルを読んでください）。

ファイルが存在しない場合、OpenClaw は単一の「ファイルがありません」マーカー行を注入します（`openclaw setup` で安全なデフォルトテンプレートが作成されます）。

`BOOTSTRAP.md` は**まったく新しいワークスペース**（他のブートストラップファイルが存在しない場合）にのみ作成されます。儀式を完了した後に削除した場合、以降の再起動時に再作成されることはありません。

ブートストラップファイルの作成を完全に無効にするには（事前準備済みのワークスペース向け）、以下を設定します:

```json5
{ agent: { skipBootstrap: true } }
```

## 組み込みツール

コアツール（read/exec/edit/write および関連するシステムツール）は、ツールポリシーに従い常に利用可能です。`apply_patch` はオプションで、`tools.exec.applyPatch` によってゲートされます。`TOOLS.md` はどのツールが存在するかを制御する**ものではありません**。それはツールの_使い方_に関するガイダンスです。

## Skills

OpenClaw は3つの場所から Skills をロードします（名前が競合した場合はワークスペースが優先）:

- バンドル（インストールに同梱）
- マネージド/ローカル: `~/.openclaw/skills`
- ワークスペース: `<workspace>/skills`

Skills は設定/環境でゲートできます（[Gateway ゲートウェイ設定](/gateway/configuration)の `skills` を参照）。

## ランタイム境界

組み込みエージェントランタイムは Pi エージェントコア（モデル、ツール、およびプロンプトパイプライン）上に構築されています。セッション管理、ディスカバリー、ツール接続、およびチャネル配信は、そのコアの上にある OpenClaw 独自のレイヤーです。

## セッション

セッショントランスクリプトは JSONL として以下に保存されます:

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

セッション ID は安定しており、OpenClaw によって選択されます。
他のツールからのレガシーセッションフォルダは読み込まれません。

## ストリーミング中のステアリング

キューモードが `steer` の場合、受信メッセージは現在の実行に注入されます。
キューに入ったステアリングは、**現在のアシスタントターンがツール呼び出しの実行を完了した後**、次の LLM 呼び出しの前に配信されます。ステアリングは現在のアシスタントメッセージの残りのツール呼び出しをスキップしなくなりました。代わりに、次のモデル境界でキューに入ったメッセージを注入します。

キューモードが `followup` または `collect` の場合、受信メッセージは現在のターンが終了するまで保持され、その後キューに入ったペイロードで新しいエージェントターンが開始されます。モードとデバウンス/キャップの動作については[キュー](/concepts/queue)を参照してください。

ブロックストリーミングは完了したアシスタントブロックを完了次第送信します。**デフォルトではオフ**です（`agents.defaults.blockStreamingDefault: "off"`）。
`agents.defaults.blockStreamingBreak` で境界を調整します（`text_end` と `message_end`、デフォルトは text_end）。
`agents.defaults.blockStreamingChunk` でソフトブロックチャンキングを制御します（デフォルトは800〜1200文字、段落区切りを優先、次に改行、文が最後）。
`agents.defaults.blockStreamingCoalesce` でストリームされたチャンクを結合し、単一行のスパムを削減します（送信前のアイドルベースのマージ）。Telegram 以外のチャネルでブロック返信を有効にするには、明示的に `*.blockStreaming: true` を設定する必要があります。
詳細なツールサマリーはツール開始時に出力されます（デバウンスなし）。Control UI はエージェントイベントが利用可能な場合、それを通じてツール出力をストリームします。
詳細: [ストリーミングとチャンキング](/concepts/streaming)。

## モデル参照

設定内のモデル参照（例: `agents.defaults.model` や `agents.defaults.models`）は**最初の** `/` で分割して解析されます。

- モデルを設定する際は `provider/model` を使用してください。
- モデル ID 自体に `/` が含まれる場合（OpenRouter スタイル）、プロバイダープレフィックスを含めてください（例: `openrouter/moonshotai/kimi-k2`）。
- プロバイダーを省略した場合、OpenClaw は入力をエイリアスまたは**デフォルトプロバイダー**のモデルとして扱います（モデル ID に `/` がない場合のみ機能します）。

## 設定（最小限）

最低限、以下を設定してください:

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom`（強く推奨）

---

_次: [グループチャット](/channels/group-messages)_ 🦞
