---
summary: "「/think」および「/verbose」のディレクティブ構文と、それらがモデルの推論に与える影響"
read_when:
  - 思考または verbose ディレクティブの解析やデフォルトを調整する場合
title: "思考レベル"
---

# 思考レベル（/think ディレクティブ）

## 何を行うか

- 受信ボディ内のインラインディレクティブ：`/t <level>`、`/think:<level>`、または `/thinking <level>`。
- レベル（エイリアス）：`off | minimal | low | medium | high | xhigh`（GPT-5.2 + Codex モデルのみ）
  - minimal → 「think」
  - low → 「think hard」
  - medium → 「think harder」
  - high → 「ultrathink」（最大予算）
  - xhigh → 「ultrathink+」（GPT-5.2 + Codex モデルのみ）
  - `x-high`、`x_high`、`extra-high`、`extra high`、および `extra_high` は `xhigh` にマップされます。
  - `highest`、`max` は `high` にマップされます。
- プロバイダーに関する注意：
  - Z.AI（`zai/*`）は二値の思考（`on`/`off`）のみをサポートします。`off` 以外のレベルはすべて `on`（`low` にマップ）として扱われます。 `off`以外のレベルは`on`として扱われます（`low`にマップされています）。

## 解決順序

1. メッセージ上のインラインディレクティブ（そのメッセージのみに適用）。
2. セッション上書き（ディレクティブのみのメッセージ送信で設定）。
3. グローバル既定（設定内の `agents.defaults.thinkingDefault`）。
4. フォールバック：推論対応モデルは low、それ以外は off。

## セッション既定の設定

- ディレクティブ **のみ** のメッセージを送信します（空白は可）。例：`/think:medium` または `/t high`。
- その設定は現在のセッションに保持されます（既定では送信者ごと）。`/think:off` またはセッションのアイドルリセットで解除されます。
- 確認返信が送信されます（`Thinking level set to high.` / `Thinking disabled.`）。レベルが無効な場合（例：`/thinking big`）、コマンドはヒント付きで拒否され、セッション状態は変更されません。 レベルが無効な場合 (例えば `/thinking big`) は、コマンドはヒント付きで拒否され、セッション状態は変更されません。
- 引数なしで `/think`（または `/think:`）を送信すると、現在の思考レベルを確認できます。

## エージェントによる適用

- **Embedded Pi**：解決されたレベルは、プロセス内の Pi エージェントランタイムに渡されます。

## Verbose ディレクティブ（/verbose または /v）

- レベル：`on`（minimal） | `full` | `off`（既定）。
- ディレクティブのみのメッセージはセッションの verbose を切り替え、`Verbose logging enabled.` / `Verbose logging disabled.` を返信します。無効なレベルは状態を変更せずにヒントを返します。
- `/verbose off` は明示的なセッション上書きを保存します。解除するには Sessions UI で `inherit` を選択します。
- インラインディレクティブはそのメッセージのみに影響し、それ以外ではセッション/グローバル既定が適用されます。
- 引数なしで `/verbose`（または `/verbose:`）を送信すると、現在の verbose レベルを確認できます。
- verbose が有効な場合、構造化ツール結果を出力するエージェント（Pi、その他の JSON エージェント）は、各ツール呼び出しをメタデータのみの個別メッセージとして返送します。利用可能な場合は `<emoji> <tool-name>: <arg>`（パス/コマンド）が接頭されます。これらのツール要約は、各ツールの開始時点で直ちに送信され（個別バブル）、ストリーミングの差分としては送信されません。 これらのツール要約は、ストリーミングのデルタではなく、各ツールが開始するとすぐに送信されます (別々のバブル)。
- verbose が `full` の場合、完了後のツール出力も転送されます（個別バブル、安全な長さに切り詰め）。実行中に `/verbose on|full|off` を切り替えた場合、その後のツールバブルは新しい設定に従います。 ランニング中に`/verbose on|full|off`をオンにすると、次のツールバブルは新しい設定になります。

## 推論の可視性（/reasoning）

- レベル：`on|off|stream`。
- ディレクティブのみのメッセージで、返信に思考ブロックを表示するかどうかを切り替えます。
- 有効時、推論は **別メッセージ** として `Reasoning:` を接頭して送信されます。
- `stream`（Telegram のみ）：返信生成中に Telegram の下書きバブルへ推論をストリームし、最終回答は推論なしで送信します。
- エイリアス：`/reason`。
- 引数なしで `/reasoning`（または `/reasoning:`）を送信すると、現在の推論レベルを確認できます。

## 関連

- Elevated mode のドキュメントは [Elevated mode](/tools/elevated) にあります。

## ハートビート

- ハートビートのプローブボディは、設定されたハートビートプロンプト（既定：`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). If nothing needs attention, reply HEARTBEAT_OK.\`）です。ハートビートメッセージ内のインラインディレクティブは通常どおり適用されます（ただし、ハートビートからセッション既定を変更することは避けてください）。
- ハートビートの配信はデフォルトで最終ペイロードのみです。 ハートビート配信は既定で最終ペイロードのみです。利用可能な場合に別個の `Reasoning:` メッセージも送信するには、`agents.defaults.heartbeat.includeReasoning: true` またはエージェントごとの `agents.list[].heartbeat.includeReasoning: true` を設定してください。

## Web チャット UI

- Web チャットの思考セレクターは、ページ読み込み時に受信セッションストア/設定に保存されたセッションのレベルを反映します。
- 別のレベルを選択すると次のメッセージにのみ適用されます（`thinkingOnce`）。送信後、セレクターは保存されたセッションレベルに戻ります。
- セッション既定を変更するには、従来どおり `/think:<level>` ディレクティブを送信してください。次回の再読み込み後にセレクターへ反映されます。
