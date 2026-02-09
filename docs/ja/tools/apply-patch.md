---
summary: "apply_patch ツールを使用して複数ファイルのパッチを適用します"
read_when:
  - 複数ファイルにまたがる構造化された編集が必要な場合
  - パッチベースの編集をドキュメント化またはデバッグしたい場合
title: "apply_patch ツール"
---

# apply_patch tool

構造化パッチフォーマットを使用してファイルの変更を適用します。 構造化されたパッチ形式を使用してファイルの変更を適用します。これは、単一の `edit` 呼び出しでは脆くなりがちな、複数ファイルまたは複数ハンクの編集に最適です。

このツールは、1 つ以上のファイル操作をラップする単一の `input` 文字列を受け取ります。

```
*** Begin Patch
*** Add File: path/to/file.txt
+line 1
+line 2
*** Update File: src/app.ts
@@
-old line
+new line
*** Delete File: obsolete.txt
*** End Patch
```

## Parameters

- `input`（必須）: `*** Begin Patch` および `*** End Patch` を含む完全なパッチ内容。

## Notes

- パスはワークスペースのルートを基準に解決されます。
- ファイル名を変更するには、`*** Update File:` ハンク内で `*** Move to:` を使用します。
- 必要に応じて、`*** End of File` は EOF のみの挿入を示します。
- 実験的、デフォルトで無効になっています。 実験的で、デフォルトでは無効です。`tools.exec.applyPatch.enabled` で有効化します。
- OpenAIのみ（OpenAIコードを含む）。 OpenAI 専用（OpenAI Codex を含む）です。必要に応じて、`tools.exec.applyPatch.allowModels` によりモデルごとにゲートできます。
- 設定は `tools.exec` の下にのみあります。

## Example

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
