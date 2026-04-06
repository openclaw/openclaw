---
read_when:
    - code_executionを有効化または設定したい場合
    - ローカルシェルアクセスなしでリモート分析を行いたい場合
    - x_searchやweb_searchとリモートPython分析を組み合わせたい場合
summary: code_execution -- xAIを使用してサンドボックス化されたリモートPython分析を実行
title: コード実行
x-i18n:
    generated_at: "2026-04-02T09:00:51Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 48ca1ddd026cb14837df90ee74859eb98ba6d1a3fbc78da8a72390d0ecee5e40
    source_path: tools/code-execution.md
    workflow: 15
---

# コード実行

`code_execution`は、xAIのResponses API上でサンドボックス化されたリモートPython分析を実行します。
これはローカルの[`exec`](/tools/exec)とは異なります：

- `exec`はあなたのマシンまたはノード上でシェルコマンドを実行します
- `code_execution`はxAIのリモートサンドボックスでPythonを実行します

`code_execution`の用途：

- 計算
- 表の作成
- 簡易統計
- チャート形式の分析
- `x_search`または`web_search`で返されたデータの分析

ローカルファイル、シェル、リポジトリ、またはペアリングされたデバイスが必要な場合は使用**しないでください**。それらには[`exec`](/tools/exec)を使用してください。

## セットアップ

xAI APIキーが必要です。以下のいずれかが使用できます：

- `XAI_API_KEY`
- `plugins.entries.xai.config.webSearch.apiKey`

例：

```json5
{
  plugins: {
    entries: {
      xai: {
        config: {
          webSearch: {
            apiKey: "xai-...",
          },
          codeExecution: {
            enabled: true,
            model: "grok-4-1-fast",
            maxTurns: 2,
            timeoutSeconds: 30,
          },
        },
      },
    },
  },
}
```

## 使い方

自然に質問し、分析の意図を明確にしてください：

```text
Use code_execution to calculate the 7-day moving average for these numbers: ...
```

```text
Use x_search to find posts mentioning OpenClaw this week, then use code_execution to count them by day.
```

```text
Use web_search to gather the latest AI benchmark numbers, then use code_execution to compare percent changes.
```

このツールは内部的に単一の`task`パラメータを受け取るため、エージェントは完全な分析リクエストとインラインデータを1つのプロンプトで送信する必要があります。

## 制限事項

- これはリモートxAI実行であり、ローカルプロセス実行ではありません。
- 一時的な分析として扱うべきであり、永続的なノートブックではありません。
- ローカルファイルやワークスペースへのアクセスは想定しないでください。
- 最新のXデータを取得するには、まず[`x_search`](/tools/web#x_search)を使用してください。

## 関連項目

- [Webツール](/tools/web)
- [Exec](/tools/exec)
- [xAI](/providers/xai)
