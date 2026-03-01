---
summary: "apply_patchツールを使用して複数ファイルのパッチを適用する"
read_when:
  - 複数ファイルにまたがる構造化ファイル編集が必要な場合
  - パッチベースの編集をドキュメント化またはデバッグしたい場合
title: "apply_patch ツール"
---

# apply_patch ツール

構造化パッチ形式を使用してファイルの変更を適用します。これは、単一の `edit` 呼び出しが脆弱になる複数ファイルまたは複数ハンクの編集に最適です。

このツールは、1つ以上のファイル操作をラップした単一の `input` 文字列を受け付けます:

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

## パラメーター

- `input`（必須）: `*** Begin Patch` と `*** End Patch` を含む完全なパッチ内容。

## 注意事項

- パッチパスは相対パス（ワークスペースディレクトリからの相対）と絶対パスをサポートしています。
- `tools.exec.applyPatch.workspaceOnly` はデフォルトで `true`（ワークスペース内に限定）です。`apply_patch` がワークスペースディレクトリ外への書き込み/削除を意図的に行いたい場合にのみ `false` に設定してください。
- `*** Update File:` ハンク内で `*** Move to:` を使用してファイルをリネームできます。
- `*** End of File` は必要な場合にEOFのみの挿入をマークします。
- 実験的機能であり、デフォルトでは無効です。`tools.exec.applyPatch.enabled` で有効化してください。
- OpenAI専用（OpenAI Codexを含む）。`tools.exec.applyPatch.allowModels` でモデルによってオプションでゲートできます。
- 設定は `tools.exec` の下にのみあります。

## 使用例

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
