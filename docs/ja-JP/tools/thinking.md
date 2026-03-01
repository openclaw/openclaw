---
summary: "/think および /verbose のディレクティブ構文とモデルの推論への影響"
read_when:
  - シンキングまたは verbose ディレクティブの解析またはデフォルトの調整
title: "シンキングレベル"
---

# シンキングレベル（/think ディレクティブ）

## 機能

- 任意の受信ボディでのインラインディレクティブ: `/t <level>`、`/think:<level>`、または `/thinking <level>`。
- レベル（エイリアス）: `off | minimal | low | medium | high | xhigh`（GPT-5.2 + Codex モデルのみ）
  - minimal → "think"
  - low → "think hard"
  - medium → "think harder"
  - high → "ultrathink"（最大バジェット）
  - xhigh → "ultrathink+"（GPT-5.2 + Codex モデルのみ）
  - `x-high`、`x_high`、`extra-high`、`extra high`、`extra_high` は `xhigh` にマッピングされます。
  - `highest`、`max` は `high` にマッピングされます。
- プロバイダーに関する注意:
  - Z.AI（`zai/*`）はバイナリシンキング（`on`/`off`）のみをサポートします。`off` 以外のレベルはすべて `on`（`low` にマッピング）として扱われます。

## 解決順序

1. メッセージのインラインディレクティブ（そのメッセージにのみ適用）。
2. セッションオーバーライド（ディレクティブのみのメッセージを送信することで設定）。
3. グローバルデフォルト（設定の `agents.defaults.thinkingDefault`）。
4. フォールバック: 推論対応モデルには low、それ以外には off。

## セッションデフォルトの設定

- **ディレクティブのみ**のメッセージを送信します（空白は許可）。例: `/think:medium` または `/t high`。
- それは現在のセッションに固定されます（デフォルトでは送信者ごと）; `/think:off` またはセッションのアイドルリセットでクリアされます。
- 確認返信が送信されます（`Thinking level set to high.` / `Thinking disabled.`）。レベルが無効な場合（例: `/thinking big`）、コマンドはヒントとともに拒否され、セッション状態は変更されません。
- 引数なしで `/think`（または `/think:`）を送信すると、現在のシンキングレベルが表示されます。

## エージェントによる適用

- **組み込み Pi**: 解決されたレベルはインプロセスの Pi エージェントランタイムに渡されます。

## Verbose ディレクティブ（/verbose または /v）

- レベル: `on`（最小）| `full` | `off`（デフォルト）。
- ディレクティブのみのメッセージはセッションの verbose を切り替え、`Verbose logging enabled.` / `Verbose logging disabled.` と返信します; 無効なレベルは状態を変更せずにヒントを返します。
- `/verbose off` は明示的なセッションオーバーライドを保存します; セッション UI で `inherit` を選択してクリアしてください。
- インラインディレクティブはそのメッセージにのみ影響します; それ以外の場合はセッション・グローバルのデフォルトが適用されます。
- 引数なしで `/verbose`（または `/verbose:`）を送信すると、現在の verbose レベルが表示されます。
- verbose がオンの場合、構造化されたツール結果を出力するエージェント（Pi、その他の JSON エージェント）は各ツール呼び出しを独自のメタデータのみのメッセージとして送信します。利用可能な場合（パス・コマンド）は `<emoji> <tool-name>: <arg>` のプレフィックスが付きます。これらのツールサマリーは各ツールが開始されるとすぐに送信されます（別々のバブル、ストリーミングデルタではありません）。
- ツール失敗サマリーは通常モードでも表示されますが、verbose が `on` または `full` でない限り、生のエラー詳細サフィックスは非表示になります。
- verbose が `full` の場合、ツール出力も完了後に転送されます（別のバブル、安全な長さに切り詰め）。実行中に `/verbose on|full|off` を切り替えると、以降のツールバブルは新しい設定に従います。

## 推論の可視化（/reasoning）

- レベル: `on|off|stream`。
- ディレクティブのみのメッセージは返信でシンキングブロックを表示するかどうかを切り替えます。
- 有効な場合、推論は `Reasoning:` がプレフィックスされた**別のメッセージ**として送信されます。
- `stream`（Telegram のみ）: 返信が生成される間、推論を Telegram のドラフトバブルにストリーミングし、最終的な回答を推論なしで送信します。
- エイリアス: `/reason`。
- 引数なしで `/reasoning`（または `/reasoning:`）を送信すると、現在の推論レベルが表示されます。

## 関連情報

- 昇格モードのドキュメントは [昇格モード](/tools/elevated) にあります。

## ハートビート

- ハートビートプローブのボディは設定済みのハートビートプロンプトです（デフォルト: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`）。ハートビートメッセージのインラインディレクティブは通常通り適用されます（ただし、ハートビートからのセッションデフォルトの変更は避けてください）。
- ハートビート配信はデフォルトで最終ペイロードのみです。（利用可能な場合）別の `Reasoning:` メッセージも送信するには、`agents.defaults.heartbeat.includeReasoning: true` またはエージェントごとの `agents.list[].heartbeat.includeReasoning: true` を設定してください。

## Web チャット UI

- Web チャットのシンキングセレクターは、ページロード時に受信セッションストア・設定からセッションの保存されたレベルを反映します。
- 別のレベルを選択すると、次のメッセージにのみ適用されます（`thinkingOnce`）; 送信後、セレクターは保存されたセッションレベルに戻ります。
- セッションデフォルトを変更するには、`/think:<level>` ディレクティブを送信してください（従来通り）; セレクターは次のリロード後に反映されます。
