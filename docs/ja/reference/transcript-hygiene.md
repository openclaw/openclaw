---
summary: "参照: プロバイダー別のトランスクリプトのサニタイズおよび修復ルール"
read_when:
  - プロバイダーのリクエスト拒否がトランスクリプトの形状に起因している問題をデバッグしている場合
  - トランスクリプトのサニタイズやツールコール修復ロジックを変更している場合
  - プロバイダー間でのツールコール ID 不一致を調査している場合
title: "トランスクリプト衛生"
x-i18n:
  source_path: reference/transcript-hygiene.md
  source_hash: 43ed460827d514a8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:23:20Z
---

# トランスクリプト衛生（プロバイダー修正）

このドキュメントは、実行前（モデルコンテキストの構築時）にトランスクリプトへ適用される **プロバイダー固有の修正** について説明します。これらは、厳格なプロバイダー要件を満たすための **インメモリ** 調整です。これらの衛生ステップは、ディスク上に保存された JSONL トランスクリプトを書き換える **ことはありません**。ただし、別途のセッションファイル修復パスにより、セッションのロード前に不正な JSONL 行を削除して不正形式の JSONL ファイルを書き換える場合があります。修復が行われた場合、元のファイルはセッションファイルと並んでバックアップされます。

スコープには以下が含まれます。

- ツールコール ID のサニタイズ
- ツールコール入力の検証
- ツール結果のペアリング修復
- ターンの検証／順序付け
- 思考シグネチャのクリーンアップ
- 画像ペイロードのサニタイズ

トランスクリプトの保存に関する詳細が必要な場合は、以下を参照してください。

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## 実行場所

すべてのトランスクリプト衛生処理は、組み込みランナーに集約されています。

- ポリシー選択: `src/agents/transcript-policy.ts`
- サニタイズ／修復の適用: `sanitizeSessionHistory`（`src/agents/pi-embedded-runner/google.ts` 内）

このポリシーは、`provider`、`modelApi`、`modelId` を使用して、適用内容を決定します。

トランスクリプト衛生とは別に、セッションファイルはロード前に（必要に応じて）修復されます。

- `repairSessionFileIfNeeded`（`src/agents/session-file-repair.ts` 内）
- `run/attempt.ts` および `compact.ts`（組み込みランナー）から呼び出し

---

## グローバルルール: 画像のサニタイズ

画像ペイロードは、サイズ制限によるプロバイダー側の拒否を防ぐため、常にサニタイズされます（過大な base64 画像のダウンスケール／再圧縮）。

実装:

- `sanitizeSessionMessagesImages`（`src/agents/pi-embedded-helpers/images.ts` 内）
- `sanitizeContentBlocksImages`（`src/agents/tool-images.ts` 内）

---

## グローバルルール: 不正形式のツールコール

`input` と `arguments` の **両方** が欠落しているアシスタントのツールコールブロックは、モデルコンテキストの構築前に破棄されます。これは、部分的に永続化されたツールコール（例えば、レート制限失敗後）によるプロバイダー拒否を防止します。

実装:

- `sanitizeToolCallInputs`（`src/agents/session-transcript-repair.ts` 内）
- `sanitizeSessionHistory`（`src/agents/pi-embedded-runner/google.ts` 内）で適用

---

## プロバイダー別マトリクス（現行動作）

**OpenAI / OpenAI Codex**

- 画像のサニタイズのみ。
- OpenAI Responses／Codex へモデル切り替え時、孤立した reasoning シグネチャ（後続の content ブロックを持たない単独の reasoning アイテム）を削除。
- ツールコール ID のサニタイズなし。
- ツール結果のペアリング修復なし。
- ターンの検証や並べ替えなし。
- 合成ツール結果なし。
- 思考シグネチャの除去なし。

**Google（Generative AI / Gemini CLI / Antigravity）**

- ツールコール ID のサニタイズ: 厳格な英数字。
- ツール結果のペアリング修復および合成ツール結果。
- ターン検証（Gemini 形式のターン交替）。
- Google のターン順序修正（履歴がアシスタントで始まる場合、極小のユーザー・ブートストラップを先頭に追加）。
- Antigravity Claude: thinking シグネチャの正規化、署名のない thinking ブロックを削除。

**Anthropic / Minimax（Anthropic 互換）**

- ツール結果のペアリング修復および合成ツール結果。
- ターン検証（厳格な交替を満たすため、連続するユーザーターンを結合）。

**Mistral（モデル ID ベースの検出を含む）**

- ツールコール ID のサニタイズ: strict9（英数字 9 文字）。

**OpenRouter Gemini**

- 思考シグネチャのクリーンアップ: base64 以外の `thought_signature` 値を除去（base64 は保持）。

**その他すべて**

- 画像のサニタイズのみ。

---

## 旧来の動作（2026.1.22 以前）

2026.1.22 リリース以前、OpenClaw は複数層のトランスクリプト衛生処理を適用していました。

- **トランスクリプト・サニタイズ拡張** が、すべてのコンテキスト構築時に実行され、以下が可能でした。
  - ツール使用／結果のペアリング修復。
  - ツールコール ID のサニタイズ（`_`/`-` を保持する非厳格モードを含む）。
- ランナーでもプロバイダー固有のサニタイズを実施しており、作業が重複していました。
- プロバイダーポリシー外でも追加の変更が行われており、以下が含まれます。
  - 永続化前にアシスタントテキストから `<final>` タグを除去。
  - 空のアシスタントエラーターンを削除。
  - ツールコール後のアシスタント内容をトリミング。

この複雑さは、プロバイダー間のリグレッション（特に `openai-responses` と
`call_id|fc_id` のペアリング）を引き起こしました。2026.1.22 の整理では拡張を削除し、ロジックをランナーに集約し、OpenAI は画像サニタイズ以外 **ノータッチ** としました。
