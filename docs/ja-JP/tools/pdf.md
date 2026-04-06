---
read_when:
    - エージェントからPDFを分析したい
    - pdf ツールの正確なパラメータと制限を知りたい
    - ネイティブPDFモードと抽出フォールバックのデバッグを行っている
summary: プロバイダーのネイティブサポートと抽出フォールバックを使用して、1つまたは複数のPDFドキュメントを分析する
title: PDF ツール
x-i18n:
    generated_at: "2026-04-02T07:56:22Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: a643cf3960cdda40cddb42883586143718065da091b070a2d29dc2ea0c6749e0
    source_path: tools/pdf.md
    workflow: 15
---

# PDF ツール

`pdf` は1つまたは複数のPDFドキュメントを分析し、テキストを返します。

基本的な動作:

- Anthropic および Google モデルプロバイダー向けのネイティブプロバイダーモード。
- その他のプロバイダー向けの抽出フォールバックモード（まずテキストを抽出し、必要に応じてページ画像を使用）。
- 単一（`pdf`）または複数（`pdfs`）入力をサポートし、1回の呼び出しにつき最大10個のPDFに対応。

## 利用条件

このツールは、OpenClaw がエージェント用にPDF対応モデル設定を解決できる場合にのみ登録されます:

1. `agents.defaults.pdfModel`
2. `agents.defaults.imageModel` へのフォールバック
3. 利用可能な認証に基づくベストエフォートのプロバイダーデフォルトへのフォールバック

使用可能なモデルが解決できない場合、`pdf` ツールは公開されません。

## 入力リファレンス

- `pdf`（`string`）: 1つのPDFパスまたはURL
- `pdfs`（`string[]`）: 複数のPDFパスまたはURL、合計最大10個
- `prompt`（`string`）: 分析プロンプト、デフォルトは `Analyze this PDF document.`
- `pages`（`string`）: `1-5` や `1,3,7-9` のようなページフィルター
- `model`（`string`）: オプションのモデル上書き（`provider/model`）
- `maxBytesMb`（`number`）: PDF1件あたりのサイズ上限（MB）

入力に関する注意:

- `pdf` と `pdfs` は読み込み前にマージされ、重複が排除されます。
- PDF入力が提供されない場合、ツールはエラーを返します。
- `pages` は1始まりのページ番号として解析され、重複排除・ソートされ、設定された最大ページ数にクランプされます。
- `maxBytesMb` のデフォルトは `agents.defaults.pdfMaxBytesMb` または `10` です。

## サポートされるPDF参照

- ローカルファイルパス（`~` 展開を含む）
- `file://` URL
- `http://` および `https://` URL

参照に関する注意:

- その他のURIスキーム（例: `ftp://`）は `unsupported_pdf_reference` で拒否されます。
- サンドボックスモードでは、リモートの `http(s)` URL は拒否されます。
- ワークスペース限定ファイルポリシーが有効な場合、許可されたルート外のローカルファイルパスは拒否されます。

## 実行モード

### ネイティブプロバイダーモード

ネイティブモードはプロバイダー `anthropic` および `google` で使用されます。
ツールは生のPDFバイトをプロバイダーAPIに直接送信します。

ネイティブモードの制限:

- `pages` はサポートされていません。設定された場合、ツールはエラーを返します。

### 抽出フォールバックモード

フォールバックモードはネイティブでないプロバイダーで使用されます。

フロー:

1. 選択されたページからテキストを抽出します（最大 `agents.defaults.pdfMaxPages`、デフォルトは `20`）。
2. 抽出されたテキストの長さが `200` 文字未満の場合、選択されたページをPNG画像にレンダリングして含めます。
3. 抽出されたコンテンツとプロンプトを選択されたモデルに送信します。

フォールバックの詳細:

- ページ画像の抽出にはピクセルバジェット `4,000,000` が使用されます。
- 対象モデルが画像入力をサポートしておらず、抽出可能なテキストもない場合、ツールはエラーを返します。
- 抽出フォールバックには `pdfjs-dist`（および画像レンダリング用の `@napi-rs/canvas`）が必要です。

## 設定

```json5
{
  agents: {
    defaults: {
      pdfModel: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["openai/gpt-5-mini"],
      },
      pdfMaxBytesMb: 10,
      pdfMaxPages: 20,
    },
  },
}
```

フィールドの詳細は[設定リファレンス](/gateway/configuration-reference)を参照してください。

## 出力の詳細

ツールは `content[0].text` にテキストを返し、`details` に構造化メタデータを返します。

主な `details` フィールド:

- `model`: 解決されたモデル参照（`provider/model`）
- `native`: ネイティブプロバイダーモードの場合は `true`、フォールバックの場合は `false`
- `attempts`: 成功前に失敗したフォールバック試行回数

パスフィールド:

- 単一PDF入力: `details.pdf`
- 複数PDF入力: `details.pdfs[]` に `pdf` エントリ
- サンドボックスパス書き換えメタデータ（該当する場合）: `rewrittenFrom`

## エラー動作

- PDF入力の欠落: `pdf required: provide a path or URL to a PDF document` をスロー
- PDFが多すぎる: `details.error = "too_many_pdfs"` で構造化エラーを返す
- サポートされていない参照スキーム: `details.error = "unsupported_pdf_reference"` を返す
- ネイティブモードで `pages` を指定: `pages is not supported with native PDF providers` の明確なエラーをスロー

## 使用例

単一PDF:

```json
{
  "pdf": "/tmp/report.pdf",
  "prompt": "Summarize this report in 5 bullets"
}
```

複数PDF:

```json
{
  "pdfs": ["/tmp/q1.pdf", "/tmp/q2.pdf"],
  "prompt": "Compare risks and timeline changes across both documents"
}
```

ページフィルター付きフォールバックモデル:

```json
{
  "pdf": "https://example.com/report.pdf",
  "pages": "1-3,7",
  "model": "openai/gpt-5-mini",
  "prompt": "Extract only customer-impacting incidents"
}
```

## 関連項目

- [ツール概要](/tools) — 利用可能なすべてのエージェントツール
- [設定リファレンス](/gateway/configuration-reference#agent-defaults) — pdfMaxBytesMb と pdfMaxPages の設定
