---
read_when:
    - 複数ファイルにまたがる構造化されたファイル編集が必要な場合
    - パッチベースの編集をドキュメント化またはデバッグしたい場合
summary: apply_patchツールで複数ファイルにパッチを適用する
title: apply_patchツール
x-i18n:
    generated_at: "2026-04-02T08:39:13Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: acca6e702e7ccdf132c71dc6d973f1d435ad6d772e1b620512c8969420cb8f7a
    source_path: tools/apply-patch.md
    workflow: 15
---

# apply_patchツール

構造化されたパッチ形式を使用してファイル変更を適用します。単一の `edit` 呼び出しでは脆くなるような複数ファイルまたは複数ハンクの編集に最適です。

このツールは、1つ以上のファイル操作をラップした単一の `input` 文字列を受け取ります：

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

## パラメータ

- `input`（必須）：`*** Begin Patch` と `*** End Patch` を含むパッチの全内容。

## 注意事項

- パッチパスは相対パス（ワークスペースディレクトリからの相対）と絶対パスの両方をサポートしています。
- `tools.exec.applyPatch.workspaceOnly` のデフォルトは `true`（ワークスペース内に限定）です。`apply_patch` がワークスペースディレクトリ外への書き込み/削除を意図的に許可する場合のみ `false` に設定してください。
- `*** Update File:` ハンク内で `*** Move to:` を使用するとファイル名を変更できます。
- `*** End of File` は必要に応じてEOF専用の挿入を示します。
- OpenAIおよびOpenAI Codexモデルではデフォルトで利用可能です。無効にするには `tools.exec.applyPatch.enabled: false` を設定してください。
- オプションで `tools.exec.applyPatch.allowModels` を使用してモデルごとに制限できます。
- 設定は `tools.exec` 配下のみです。

## 例

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
