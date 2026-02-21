---
summary: "Agentランタイム（組み込みpi-mono）、ワークスペースの構成、セッションの起動について"
read_when:
  - Agentランタイム、ワークスペースの初期化、セッションの挙動を変更したい
title: "Agentランタイム"
---

# Agentランタイム

OpenClawは**pi-mono**から派生した単一の組み込みAgentランタイムを実行する。

## ワークスペース（必須）

OpenClawは単一のAgentワークスペースディレクトリ（`agents.defaults.workspace`）を、ツールとコンテキストの**唯一の**作業ディレクトリ（`cwd`）として使用する。

推奨: `openclaw setup`を実行して、`~/.openclaw/openclaw.json`が存在しない場合は作成し、ワークスペースファイルを初期化する。

ワークスペースの構成とバックアップについては[Agentワークスペース](/concepts/agent-workspace)を参照。

`agents.defaults.sandbox`が有効な場合、mainセッション以外では`agents.defaults.sandbox.workspaceRoot`配下のセッション別ワークスペースで上書きできる（[Gateway設定](/gateway/configuration)を参照）。

## 起動ファイル（自動挿入）

`agents.defaults.workspace`内で、OpenClawは以下のユーザー編集可能なファイルを参照する:

- `AGENTS.md` — 動作指示と「記憶」
- `SOUL.md` — ペルソナ、境界、トーン
- `TOOLS.md` — ユーザーが管理するツールのメモ（例: `imsg`、`sag`、各種規約）
- `BOOTSTRAP.md` — 初回起動時の儀式（完了後に削除）
- `IDENTITY.md` — Agent名、雰囲気、絵文字
- `USER.md` — ユーザープロフィール、呼び方の好み

新しいセッションの最初のターンで、OpenClawはこれらのファイルの内容をAgentコンテキストに直接挿入する。

空のファイルはスキップされる。大きなファイルはプロンプトを軽量に保つため、マーカー付きでトリミング・省略される（全内容はファイルを読めば確認できる）。

ファイルが存在しない場合、OpenClawは「ファイルがない」旨のマーカー行を1行挿入する（`openclaw setup`で安全なデフォルトテンプレートが作成される）。

`BOOTSTRAP.md`は**新規ワークスペース**（他の起動ファイルが存在しない状態）でのみ作成される。儀式を終えて削除すれば、以降の再起動で再作成されることはない。

起動ファイルの作成を完全に無効化するには（事前に用意したワークスペース向け）、以下を設定:

```json5
{ agent: { skipBootstrap: true } }
```

## 組み込みツール

コアツール（read/exec/edit/writeおよび関連システムツール）は常に利用可能で、ツールポリシーに従う。`apply_patch`はオプションで、`tools.exec.applyPatch`でゲートされている。`TOOLS.md`はどのツールが存在するかを制御するものではなく、ツールをどう使ってほしいかのガイダンスである。

## スキル

OpenClawは以下の3箇所からスキルを読み込む（名前が衝突した場合はワークスペースが優先）:

- バンドル（インストールに同梱）
- マネージド/ローカル: `~/.openclaw/skills`
- ワークスペース: `<workspace>/skills`

スキルは設定や環境変数でゲートできる（[Gateway設定](/gateway/configuration)の`skills`を参照）。

## pi-monoとの統合

OpenClawはpi-monoのコード（models/tools）を再利用しているが、**セッション管理、ディスカバリ、ツール接続はOpenClaw独自**である。

- pi-coding agentランタイムは使用しない。
- `~/.pi/agent`や`<workspace>/.pi`の設定は参照されない。

## セッション

セッションのトランスクリプトはJSONLで以下に保存される:

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

セッションIDは安定しており、OpenClawによって決定される。
旧来のPi/Tauセッションフォルダは**読み込まれない**。

## ストリーミング中の操舵

キューモードが`steer`の場合、受信メッセージは実行中のランに挿入される。キューは**各ツールコールの後**にチェックされる。キューにメッセージがあれば、現在のアシスタントメッセージの残りのツールコールはスキップされ（「キューにユーザーメッセージがあるためスキップ」というエラー結果）、次のアシスタント応答の前にキュー内のユーザーメッセージが挿入される。

キューモードが`followup`または`collect`の場合、受信メッセージは現在のターンが終わるまで保持され、その後キューに溜まったペイロードで新しいAgentターンが開始される。モードとデバウンス/上限の挙動は[キュー](/concepts/queue)を参照。

ブロックストリーミングは完了したアシスタントブロックを完了次第送信する。**デフォルトでは無効**（`agents.defaults.blockStreamingDefault: "off"`）。
境界は`agents.defaults.blockStreamingBreak`で調整（`text_end`または`message_end`、デフォルトはtext_end）。
ソフトブロックのチャンク分割は`agents.defaults.blockStreamingChunk`で制御（デフォルト800〜1200文字、段落区切りを優先、次に改行、最後に文）。
ストリーミングチャンクの結合は`agents.defaults.blockStreamingCoalesce`で設定でき、単行スパムを軽減（送信前にアイドルベースでマージ）。Telegram以外のチャンネルでブロック返信を有効にするには、明示的に`*.blockStreaming: true`が必要。
ツールサマリーはツール開始時に出力される（デバウンスなし）。Control UIはagentイベント経由でツール出力をストリーミングする（利用可能な場合）。
詳細は[ストリーミング + チャンク分割](/concepts/streaming)を参照。

## モデルの指定

設定内のモデル参照（例: `agents.defaults.model`、`agents.defaults.models`）は**最初の**`/`で分割してパースされる。

- モデルを設定するときは`provider/model`形式を使う。
- モデルID自体に`/`が含まれる場合（OpenRouterスタイル）、プロバイダーのプレフィックスを含める（例: `openrouter/moonshotai/kimi-k2`）。
- プロバイダーを省略すると、OpenClawはその入力を**デフォルトプロバイダー**のエイリアスまたはモデルとして扱う（モデルIDに`/`が含まれない場合のみ有効）。

## 最小構成

最低限、以下を設定する:

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom`（強く推奨）

---

_次へ: [グループチャット](/channels/group-messages)_
