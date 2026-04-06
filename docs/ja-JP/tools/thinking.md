---
read_when:
    - 思考、高速モード、またはverboseディレクティブのパースやデフォルト値を調整する場合
summary: /think、/fast、/verbose、および推論の表示に関するディレクティブ構文
title: 思考レベル
x-i18n:
    generated_at: "2026-04-02T07:57:38Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 8e5c65d06a182e4f7642c7be5dea9172c79ada5949fdfeeb48d9e4a2c5e90601
    source_path: tools/thinking.md
    workflow: 15
---

# 思考レベル (/think ディレクティブ)

## 機能

- 受信メッセージ本文内のインラインディレクティブ: `/t <level>`、`/think:<level>`、または `/thinking <level>`。
- レベル（エイリアス）: `off | minimal | low | medium | high | xhigh | adaptive`
  - minimal → 「think」
  - low → 「think hard」
  - medium → 「think harder」
  - high → 「ultrathink」（最大バジェット）
  - xhigh → 「ultrathink+」（GPT-5.2 + Codex モデルのみ）
  - adaptive → プロバイダー管理の適応型推論バジェット（Anthropic Claude 4.6 モデルファミリーでサポート）
  - `x-high`、`x_high`、`extra-high`、`extra high`、`extra_high` は `xhigh` にマッピングされる。
  - `highest`、`max` は `high` にマッピングされる。
- プロバイダーに関する注意事項:
  - Anthropic Claude 4.6 モデルは、明示的な思考レベルが設定されていない場合、デフォルトで `adaptive` になる。
  - Z.AI (`zai/*`) はバイナリの思考（`on`/`off`）のみをサポートする。`off` 以外のレベルはすべて `on`（`low` にマッピング）として扱われる。
  - Moonshot (`moonshot/*`) は `/think off` を `thinking: { type: "disabled" }` にマッピングし、`off` 以外のレベルを `thinking: { type: "enabled" }` にマッピングする。思考が有効な場合、Moonshot は `tool_choice` として `auto|none` のみを受け付ける。OpenClaw は互換性のない値を `auto` に正規化する。

## 解決順序

1. メッセージのインラインディレクティブ（そのメッセージにのみ適用）。
2. セッションのオーバーライド（ディレクティブのみのメッセージを送信して設定）。
3. エージェントごとのデフォルト（設定の `agents.list[].thinkingDefault`）。
4. グローバルデフォルト（設定の `agents.defaults.thinkingDefault`）。
5. フォールバック: Anthropic Claude 4.6 モデルの場合は `adaptive`、その他の推論対応モデルの場合は `low`、それ以外は `off`。

## セッションデフォルトの設定

- ディレクティブ**のみ**のメッセージを送信する（空白は許可）。例: `/think:medium` または `/t high`。
- 現在のセッションに適用される（デフォルトでは送信者ごと）。`/think:off` またはセッションのアイドルリセットでクリアされる。
- 確認の返信が送信される（`Thinking level set to high.` / `Thinking disabled.`）。レベルが無効な場合（例: `/thinking big`）、コマンドはヒントとともに拒否され、セッションの状態は変更されない。
- 引数なしで `/think`（または `/think:`）を送信すると、現在の思考レベルを確認できる。

## エージェントごとの適用

- **組み込み Pi**: 解決されたレベルはインプロセスの Pi エージェントランタイムに渡される。

## 高速モード (/fast)

- レベル: `on|off`。
- ディレクティブのみのメッセージでセッションの高速モードオーバーライドを切り替え、`Fast mode enabled.` / `Fast mode disabled.` と返信する。
- モードなしで `/fast`（または `/fast status`）を送信すると、現在の有効な高速モード状態を確認できる。
- OpenClaw は以下の順序で高速モードを解決する:
  1. インライン/ディレクティブのみの `/fast on|off`
  2. セッションのオーバーライド
  3. エージェントごとのデフォルト（`agents.list[].fastModeDefault`）
  4. モデルごとの設定: `agents.defaults.models["<provider>/<model>"].params.fastMode`
  5. フォールバック: `off`
- `openai/*` の場合、高速モードはサポートされている Responses リクエストで `service_tier=priority` を送信することで OpenAI の優先処理にマッピングされる。
- `openai-codex/*` の場合、高速モードは Codex Responses で同じ `service_tier=priority` フラグを送信する。OpenClaw は両方の認証パスで1つの共有 `/fast` トグルを維持する。
- `api.anthropic.com` に送信される OAuth 認証済みトラフィックを含む、直接のパブリック `anthropic/*` リクエストの場合、高速モードは Anthropic のサービスティアにマッピングされる: `/fast on` は `service_tier=auto` を設定し、`/fast off` は `service_tier=standard_only` を設定する。
- 明示的な Anthropic の `serviceTier` / `service_tier` モデルパラメータは、両方が設定されている場合に高速モードのデフォルトをオーバーライドする。OpenClaw は Anthropic 以外のプロキシベース URL に対しては Anthropic サービスティアの注入をスキップする。

## verbose ディレクティブ (/verbose または /v)

- レベル: `on`（最小）| `full` | `off`（デフォルト）。
- ディレクティブのみのメッセージでセッションの verbose を切り替え、`Verbose logging enabled.` / `Verbose logging disabled.` と返信する。無効なレベルの場合は状態を変更せずにヒントを返す。
- `/verbose off` は明示的なセッションオーバーライドを保存する。セッション UI で `inherit` を選択してクリアする。
- インラインディレクティブはそのメッセージにのみ影響する。それ以外の場合はセッション/グローバルデフォルトが適用される。
- 引数なしで `/verbose`（または `/verbose:`）を送信すると、現在の verbose レベルを確認できる。
- verbose が有効な場合、構造化されたツール結果を出力するエージェント（Pi やその他の JSON エージェント）は、各ツール呼び出しをメタデータのみのメッセージとして返し、利用可能な場合は `<emoji> <tool-name>: <arg>`（パス/コマンド）をプレフィックスとして付ける。これらのツールサマリーは各ツールの開始時に送信され（個別のバブル）、ストリーミングデルタとしてではない。
- ツール失敗のサマリーは通常モードでも表示されるが、生のエラー詳細サフィックスは verbose が `on` または `full` でない限り非表示になる。
- verbose が `full` の場合、ツール出力も完了後に転送される（個別のバブル、安全な長さに切り詰め）。実行中に `/verbose on|full|off` を切り替えた場合、後続のツールバブルは新しい設定に従う。

## 推論の表示 (/reasoning)

- レベル: `on|off|stream`。
- ディレクティブのみのメッセージで、返信に思考ブロックを表示するかどうかを切り替える。
- 有効な場合、推論は `Reasoning:` をプレフィックスとした**個別のメッセージ**として送信される。
- `stream`（Telegram のみ）: 返信の生成中に推論を Telegram のドラフトバブルにストリーミングし、最終回答は推論なしで送信する。
- エイリアス: `/reason`。
- 引数なしで `/reasoning`（または `/reasoning:`）を送信すると、現在の推論レベルを確認できる。
- 解決順序: インラインディレクティブ、次にセッションのオーバーライド、次にエージェントごとのデフォルト（`agents.list[].reasoningDefault`）、次にフォールバック（`off`）。

## 関連項目

- 昇格モードのドキュメントは[昇格モード](/tools/elevated)を参照。

## ハートビート

- ハートビートのプローブ本文は設定されたハートビートプロンプトである（デフォルト: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`）。ハートビートメッセージのインラインディレクティブは通常通り適用される（ただしハートビートからセッションデフォルトを変更することは避けること）。
- ハートビートの配信はデフォルトで最終ペイロードのみである。利用可能な場合に個別の `Reasoning:` メッセージも送信するには、`agents.defaults.heartbeat.includeReasoning: true` またはエージェントごとの `agents.list[].heartbeat.includeReasoning: true` を設定する。

## Web チャット UI

- Web チャットの思考セレクターは、ページ読み込み時に受信セッションストア/設定から保存されたセッションのレベルを反映する。
- 別のレベルを選択すると次のメッセージにのみ適用される（`thinkingOnce`）。送信後、セレクターは保存されたセッションレベルに戻る。
- セッションデフォルトを変更するには、（従来通り）`/think:<level>` ディレクティブを送信する。次のリロード後にセレクターに反映される。
