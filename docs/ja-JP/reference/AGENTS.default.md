---
title: "デフォルト AGENTS.md"
summary: "パーソナルアシスタント設定のための OpenClaw エージェントのデフォルト指示とスキル一覧"
read_when:
  - 新しい OpenClaw エージェントセッションを開始するとき
  - デフォルトスキルの有効化または監査を行うとき
---

# AGENTS.md — OpenClaw パーソナルアシスタント（デフォルト）

## 初回実行（推奨）

OpenClaw はエージェント専用のワークスペースディレクトリを使用します。デフォルト: `~/.openclaw/workspace`（`agents.defaults.workspace` で変更可能）。

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

3. 任意: パーソナルアシスタントのスキル一覧を使用する場合は、AGENTS.md をこのファイルで置き換えます:

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. 任意: `agents.defaults.workspace` を設定して別のワークスペースを選択します（`~` をサポート）:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## 安全のデフォルト設定

- ディレクトリやシークレットをチャットにダンプしないでください。
- 明示的に要求されない限り、破壊的なコマンドを実行しないでください。
- 外部メッセージングサーフェスには部分的/ストリーミングの返信を送らないでください（最終的な返信のみ）。

## セッション開始時（必須）

- `SOUL.md`、`USER.md`、`memory.md`、および `memory/` 内の今日と昨日のファイルを読んでください。
- 応答する前に行ってください。

## ソウル（必須）

- `SOUL.md` はアイデンティティ、トーン、および境界を定義します。常に最新の状態に保ってください。
- `SOUL.md` を変更した場合は、ユーザーに伝えてください。
- セッションごとに新しいインスタンスが起動します。継続性はこれらのファイルに保存されています。

## 共有スペース（推奨）

- あなたはユーザーの代弁者ではありません。グループチャットや公開チャンネルでは注意してください。
- プライベートなデータ、連絡先情報、内部メモは共有しないでください。

## メモリシステム（推奨）

- 日次ログ: `memory/YYYY-MM-DD.md`（必要に応じて `memory/` を作成してください）。
- 長期記憶: `memory.md` に永続的な事実、好み、決定を記録します。
- セッション開始時に、今日と昨日のファイル、および存在する場合は `memory.md` を読んでください。
- 記録すべき内容: 決定、好み、制約、未完了のタスク。
- 明示的に要求されない限り、シークレットは避けてください。

## ツールとスキル

- ツールはスキル内にあります。必要な場合は各スキルの `SKILL.md` に従ってください。
- 環境固有のメモは `TOOLS.md`（スキルのメモ）に保管してください。

## バックアップのヒント（推奨）

このワークスペースを Clawd の「メモリ」として扱う場合、`AGENTS.md` とメモリファイルがバックアップされるよう、git リポジトリ（できればプライベート）にしてください。

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# 任意: プライベートリモートを追加してプッシュ
```

## OpenClaw の機能

- WhatsApp Gateway と Pi コーディングエージェントを実行し、アシスタントがチャットの読み書き、コンテキストの取得、ホスト Mac 経由のスキル実行を行えるようにします。
- macOS アプリは権限（画面録画、通知、マイク）を管理し、バンドルされたバイナリを介して `openclaw` CLI を公開します。
- ダイレクトチャットはデフォルトでエージェントの `main` セッションに集約されます。グループは `agent:<agentId>:<channel>:group:<id>` として分離されます（ルーム/チャンネル: `agent:<agentId>:<channel>:channel:<id>`）。ハートビートによってバックグラウンドタスクが維持されます。

## コアスキル（設定 → スキルで有効化）

- **mcporter** — 外部スキルバックエンドを管理するためのツールサーバーランタイム/CLI。
- **Peekaboo** — オプションの AI ビジョン分析を備えた高速 macOS スクリーンショット。
- **camsnap** — RTSP/ONVIF セキュリティカメラからフレーム、クリップ、またはモーションアラートをキャプチャ。
- **oracle** — セッション再生とブラウザコントロールを備えた OpenAI 対応エージェント CLI。
- **eightctl** — ターミナルからスリープを制御します。
- **imsg** — iMessage と SMS の送信、読み取り、ストリーミング。
- **wacli** — WhatsApp CLI: 同期、検索、送信。
- **discord** — Discord アクション: リアクション、スタンプ、投票。`user:<id>` または `channel:<id>` ターゲットを使用します（裸の数値 ID はあいまいです）。
- **gog** — Google Suite CLI: Gmail、Calendar、Drive、Contacts。
- **spotify-player** — 再生の検索/キュー/コントロールのためのターミナル Spotify クライアント。
- **sag** — mac スタイルの say UX を備えた ElevenLabs 音声。デフォルトでスピーカーにストリーミングします。
- **Sonos CLI** — スクリプトから Sonos スピーカーを制御します（検出/状態/再生/音量/グルーピング）。
- **blucli** — スクリプトから BluOS プレーヤーを再生、グループ化、自動化します。
- **OpenHue CLI** — シーンと自動化のための Philips Hue 照明コントロール。
- **OpenAI Whisper** — クイック口述筆記とボイスメール文字起こしのためのローカル音声テキスト変換。
- **Gemini CLI** — 高速 Q&A のためのターミナルから Google Gemini モデル。
- **agent-tools** — 自動化とヘルパースクリプトのためのユーティリティツールキット。

## 使用上の注意

- スクリプト作成には `openclaw` CLI を優先してください。権限は mac アプリが処理します。
- スキルタブからインストールを実行してください。バイナリが既に存在する場合はボタンが非表示になります。
- アシスタントがリマインダーのスケジュール、受信トレイの監視、カメラキャプチャのトリガーを行えるよう、ハートビートを有効のままにしてください。
- Canvas UI はネイティブオーバーレイ付きでフルスクリーンで動作します。重要なコントロールを左上/右上/下端に配置しないようにしてください。レイアウトに明示的なガターを追加し、セーフエリアのインセットに依存しないでください。
- ブラウザ駆動の検証には、OpenClaw が管理する Chrome プロファイルで `openclaw browser`（タブ/状態/スクリーンショット）を使用してください。
- DOM 検査には `openclaw browser eval|query|dom|snapshot`（およびマシン出力が必要な場合は `--json`/`--out`）を使用してください。
- インタラクションには `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run` を使用してください（click/type にはスナップショット参照が必要です。CSS セレクターには `evaluate` を使用してください）。
