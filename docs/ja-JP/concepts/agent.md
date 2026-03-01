---
summary: "エージェントランタイム（組み込みpi-mono）、ワークスペース規約、セッションブートストラップ"
read_when:
  - Changing agent runtime, workspace bootstrap, or session behavior
title: "エージェントランタイム"
---

# エージェントランタイム

OpenClawは**pi-mono**から派生した単一の組み込みエージェントランタイムを実行します。

## ワークスペース（必須）

OpenClawは単一のエージェントワークスペースディレクトリ（`agents.defaults.workspace`）を、ツールとコンテキストのためのエージェントの**唯一の**作業ディレクトリ（`cwd`）として使用します。

推奨: `~/.openclaw/openclaw.json`が存在しない場合は`openclaw setup`を使用して作成し、ワークスペースファイルを初期化してください。

ワークスペースの完全なレイアウト + バックアップガイド: [エージェントワークスペース](/concepts/agent-workspace)

`agents.defaults.sandbox`が有効な場合、メイン以外のセッションは`agents.defaults.sandbox.workspaceRoot`配下のセッションごとのワークスペースでオーバーライドできます（[Gateway設定](/gateway/configuration)を参照）。

## ブートストラップファイル（注入）

`agents.defaults.workspace`内に、OpenClawは以下のユーザー編集可能なファイルを想定しています:

- `AGENTS.md` -- 操作手順 + 「メモリ」
- `SOUL.md` -- ペルソナ、境界、トーン
- `TOOLS.md` -- ユーザーが管理するツールノート（例: `imsg`、`sag`、規約）
- `BOOTSTRAP.md` -- 初回実行時の儀式（完了後に削除）
- `IDENTITY.md` -- エージェントの名前/雰囲気/絵文字
- `USER.md` -- ユーザープロフィール + 呼び方の設定

新しいセッションの最初のターンで、OpenClawはこれらのファイルの内容をエージェントコンテキストに直接注入します。

空のファイルはスキップされます。大きなファイルはトリミングおよび切り詰められ、プロンプトを軽量に保つためのマーカーが付けられます（完全な内容はファイルを読んでください）。

ファイルが見つからない場合、OpenClawは1行の「missing file」マーカーを注入します（`openclaw setup`が安全なデフォルトテンプレートを作成します）。

`BOOTSTRAP.md`は**新規ワークスペース**（他のブートストラップファイルが存在しない場合）でのみ作成されます。儀式を完了した後に削除した場合、後の再起動時に再作成されることはありません。

ブートストラップファイルの作成を完全に無効にするには（事前にシードされたワークスペースの場合）、以下を設定します:

```json5
{ agent: { skipBootstrap: true } }
```

## ビルトインツール

コアツール（read/exec/edit/writeおよび関連するシステムツール）は、ツールポリシーに従い常に利用可能です。`apply_patch`はオプションで、`tools.exec.applyPatch`によってゲートされます。`TOOLS.md`はどのツールが存在するかを制御するものでは**ありません**。ツールをどのように使ってほしいかのガイダンスです。

## スキル

OpenClawは3つの場所からスキルを読み込みます（名前が競合した場合はワークスペースが優先）:

- バンドル（インストールに同梱）
- マネージド/ローカル: `~/.openclaw/skills`
- ワークスペース: `<workspace>/skills`

スキルは設定/環境変数でゲートできます（[Gateway設定](/gateway/configuration)の`skills`を参照）。

## pi-mono統合

OpenClawはpi-monoコードベースの一部（モデル/ツール）を再利用しますが、**セッション管理、ディスカバリ、ツールの配線はOpenClaw独自のもの**です。

- pi-codingエージェントランタイムはありません。
- `~/.pi/agent`や`<workspace>/.pi`の設定は参照されません。

## セッション

セッションのトランスクリプトはJSONLとして以下に保存されます:

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

セッションIDは安定しており、OpenClawによって選択されます。
レガシーのPi/Tauセッションフォルダは**読み込まれません**。

## ストリーミング中のステアリング

キューモードが`steer`の場合、受信メッセージは現在の実行に注入されます。
キューは**各ツール呼び出しの後に**チェックされます。キューにメッセージがある場合、現在のアシスタントメッセージの残りのツール呼び出しはスキップされ（「Skipped due to queued user message.」というエラーツール結果）、次のアシスタント応答の前にキューに入れられたユーザーメッセージが注入されます。

キューモードが`followup`または`collect`の場合、受信メッセージは現在のターンが終了するまで保持され、その後キューに入れられたペイロードで新しいエージェントターンが開始されます。モード + デバウンス/キャップの動作については[キュー](/concepts/queue)を参照してください。

ブロックストリーミングは完了したアシスタントブロックを完成次第送信します。**デフォルトではオフ**です（`agents.defaults.blockStreamingDefault: "off"`）。
境界は`agents.defaults.blockStreamingBreak`（`text_end` vs `message_end`、デフォルトはtext_end）で調整できます。
ソフトブロックチャンキングは`agents.defaults.blockStreamingChunk`で制御します（デフォルトは800〜1200文字、段落区切りを優先、次に改行、最後に文）。
ストリーミングされたチャンクの結合は`agents.defaults.blockStreamingCoalesce`で行い、送信前のアイドルベースのマージで単一行スパムを削減します。Telegram以外のチャンネルではブロック返信を有効にするために明示的に`*.blockStreaming: true`が必要です。
ツール開始時に詳細なツールサマリーが出力されます（デバウンスなし）。コントロールUIは利用可能な場合、エージェントイベント経由でツール出力をストリーミングします。
詳細: [ストリーミング + チャンキング](/concepts/streaming)。

## モデル参照

設定のモデル参照（例: `agents.defaults.model`および`agents.defaults.models`）は**最初の**`/`で分割してパースされます。

- モデルを設定する際は`provider/model`を使用してください。
- モデルID自体に`/`が含まれる場合（OpenRouterスタイル）、プロバイダープレフィックスを含めてください（例: `openrouter/moonshotai/kimi-k2`）。
- プロバイダーを省略した場合、OpenClawは入力をエイリアスまたは**デフォルトプロバイダー**のモデルとして扱います（モデルIDに`/`がない場合のみ機能します）。

## 設定（最小限）

最低限、以下を設定してください:

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom`（強く推奨）

---

_次: [グループチャット](/channels/group-messages)_
