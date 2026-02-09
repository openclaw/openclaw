---
summary: "個人アシスタント設定向けのデフォルト OpenClaw エージェント指示と Skills 一覧"
read_when:
  - 新しい OpenClaw エージェントセッションを開始する場合
  - デフォルト Skills を有効化または監査する場合
---

# AGENTS.md — OpenClaw 個人アシスタント（デフォルト）

## 初回実行（推奨）

OpenClawはエージェントの専用ワークスペースディレクトリを使用します。 OpenClaw は、エージェント用に専用のワークスペースディレクトリを使用します。デフォルトは `~/.openclaw/workspace` です（`agents.defaults.workspace` で設定可能）。

1. ワークスペースを作成します（まだ存在しない場合）:

```bash
mkdir -p ~/.openclaw/workspace
```

2. デフォルトのワークスペーステンプレートをワークスペースにコピーします:

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. 任意: 個人アシスタントの Skills 一覧を使用したい場合は、AGENTS.md をこのファイルに置き換えます:

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. 任意: `agents.defaults.workspace` を設定して別のワークスペースを選択します（`~` をサポート）:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## 安全性のデフォルト

- ディレクトリやシークレットをチャットにダンプしないでください。
- 明示的に依頼されない限り、破壊的なコマンドを実行しないでください。
- 外部メッセージング面には部分的／ストリーミングの返信を送信しないでください（最終返信のみ）。

## セッション開始（必須）

- `SOUL.md`、`USER.md`、`memory.md`、および `memory/` の「今日＋昨日」を読みます。
- 応答する前に実行してください。

## Soul（必須）

- `SOUL.md` は、アイデンティティ、トーン、境界を定義します。常に最新の状態に保ってください。 そのままにしておきなさい。
- `SOUL.md` を変更した場合は、ユーザーに伝えてください。
- 各セッションは新しいインスタンスです。継続性はこれらのファイルにあります。

## 共有スペース（推奨）

- あなたはユーザーの代弁者ではありません。グループチャットや公開チャンネルでは注意してください。
- 個人データ、連絡先情報、内部メモを共有しないでください。

## メモリーシステム（推奨）

- デイリーログ: `memory/YYYY-MM-DD.md`（必要に応じて `memory/` を作成）。
- 長期メモリー: `memory.md` に、永続的な事実、好み、意思決定を記録します。
- セッション開始時に、今日＋昨日＋存在する場合は `memory.md` を読みます。
- キャプチャ:決定、設定、制約、開いているループ。
- 明示的に要求されない限り秘密を避けてください。

## ツールと Skills

- ツールは Skills 内にあります。必要な場合は、各 Skill の `SKILL.md` に従ってください。
- 環境固有のメモは `TOOLS.md`（Notes for Skills）に保持します。

## バックアップのヒント（推奨）

このワークスペースを Clawd の「メモリー」として扱う場合は、git リポジトリ（理想的にはプライベート）にして、`AGENTS.md` とメモリーファイルをバックアップしてください。

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## OpenClaw の機能

- WhatsApp ゲートウェイと Pi コーディングエージェントを実行し、アシスタントがチャットの読み書き、コンテキスト取得、ホスト Mac 経由での Skills 実行を行えるようにします。
- macOS アプリは、権限（画面収録、通知、マイク）を管理し、同梱バイナリを通じて `openclaw` CLI を公開します。
- ダイレクトチャットは、デフォルトでエージェントの `main` セッションに集約されます。グループは `agent:<agentId>:<channel>:group:<id>`（ルーム／チャンネル: `agent:<agentId>:<channel>:channel:<id>`）として分離されます。ハートビートによりバックグラウンドタスクが維持されます。

## コア Skills（設定 → Skills で有効化）

- **mcporter** — 外部 Skill バックエンドを管理するためのツールサーバーランタイム／CLI。
- **Peekaboo** — 高速な macOS スクリーンショット。任意で AI ビジョン解析に対応。
- **camsnap** — RTSP/ONVIF セキュリティカメラからフレーム、クリップ、または動体アラートを取得。
- **oracle** — セッション再生とブラウザー制御を備えた OpenAI 対応エージェント CLI。
- **eightctl** — ターミナルから睡眠を制御します。
- **imsg** — iMessage と SMS の送信、読み取り、ストリーミング。
- **wacli** — WhatsApp CLI。同期、検索、送信。
- **discord** — Discordアクション：反応、ステッカー、投票。 `user:<id>` または `channel:<id>` ターゲットを使用します。(素の数値idは曖昧です)。
- **gog** — Google Suite CLI。Gmail、Calendar、Drive、Contacts。
- **spotify-player** — 検索／キュー／再生制御が可能なターミナル Spotify クライアント。
- **sag** — ElevenLabs 音声を mac スタイルの say UX で提供。デフォルトでスピーカーへストリーミングします。
- **Sonos CLI** — スクリプトから Sonos スピーカー（検出／状態／再生／音量／グルーピング）を制御。
- **blucli** — スクリプトから BluOS プレーヤーを再生、グループ化、自動化。
- **OpenHue CLI** — Philips Hue 照明のシーンおよびオートメーション制御。
- **OpenAI Whisper** — クイックな口述や留守電文字起こしのためのローカル音声認識。
- **Gemini CLI** — 高速な Q&A のためにターミナルから Google Gemini モデルを利用。
- **agent-tools** — 自動化およびヘルパースクリプト用のユーティリティツールキット。

## 使用上の注意

- スクリプトには `openclaw` CLI を優先してください。権限は mac アプリが処理します。
- インストールは Skills タブから実行してください。バイナリが既に存在する場合、ボタンは非表示になります。
- ハートビートを有効にして、アシスタントがリマインダーのスケジュール、受信箱の監視、カメラキャプチャのトリガーを行えるようにしてください。
- Canvas UI はネイティブオーバーレイ付きのフルスクリーンを実行します。 左上/右上/下のエッジに重要なコントロールを配置しないでください。レイアウトに明示的なガターを追加し、セーフエリアのインセットに頼らないでください。
- ブラウザー駆動の検証には、OpenClaw 管理の Chrome プロファイルで `openclaw browser`（タブ／ステータス／スクリーンショット）を使用してください。
- DOM 検査には `openclaw browser eval|query|dom|snapshot` を使用してください（機械出力が必要な場合は `--json`/`--out`）。
- インタラクションには `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run` を使用してください（クリック／入力にはスナップショット参照が必要です。CSS セレクターには `evaluate` を使用します）。
