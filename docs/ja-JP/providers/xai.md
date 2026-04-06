---
read_when:
    - OpenClaw で Grok モデルを使用したい場合
    - xAI の認証またはモデルIDを設定している場合
summary: OpenClaw で xAI Grok モデルを使用する
title: xAI
x-i18n:
    generated_at: "2026-04-02T07:51:12Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 946ed2b766e2195e87e322a6f58ca6ea376ee1a44c9e016347c95c14203a22da
    source_path: providers/xai.md
    workflow: 15
---

# xAI

OpenClaw には Grok モデル用のバンドル済み `xai` プロバイダープラグインが同梱されています。

## セットアップ

1. xAI コンソールでAPIキーを作成します。
2. `XAI_API_KEY` を設定するか、以下を実行します:

```bash
openclaw onboard --auth-choice xai-api-key
```

3. 以下のようにモデルを選択します:

```json5
{
  agents: { defaults: { model: { primary: "xai/grok-4" } } },
}
```

OpenClaw は現在、バンドル済みの xAI トランスポートとして xAI Responses API を使用しています。同じ `XAI_API_KEY` で、Grok ベースの `web_search`、ファーストクラスの `x_search`、およびリモート `code_execution` も利用できます。
`plugins.entries.xai.config.webSearch.apiKey` に xAI キーを保存している場合、バンドル済みの xAI モデルプロバイダーはそのキーをフォールバックとしても再利用します。
`code_execution` の調整は `plugins.entries.xai.config.codeExecution` で行います。

## 現在のバンドル済みモデルカタログ

OpenClaw には以下の xAI モデルファミリーがデフォルトで含まれています:

- `grok-4`、`grok-4-0709`
- `grok-4-fast-reasoning`、`grok-4-fast-non-reasoning`
- `grok-4-1-fast-reasoning`、`grok-4-1-fast-non-reasoning`
- `grok-4.20-reasoning`、`grok-4.20-non-reasoning`
- `grok-code-fast-1`

プラグインは、同じAPI形式に従う新しい `grok-4*` および `grok-code-fast*` IDも前方解決します。

## ウェブ検索

バンドル済みの `grok` ウェブ検索プロバイダーも `XAI_API_KEY` を使用します:

```bash
openclaw config set tools.web.search.provider grok
```

## 既知の制限事項

- 現時点では認証はAPIキーのみです。OpenClaw には xAI OAuth/デバイスコードフローはまだありません。
- `grok-4.20-multi-agent-experimental-beta-0304` は、標準の OpenClaw xAI トランスポートとは異なるアップストリームAPIサーフェスを必要とするため、通常の xAI プロバイダーパスではサポートされていません。

## 備考

- OpenClaw は共有ランナーパス上で xAI 固有のツールスキーマおよびツール呼び出しの互換性修正を自動的に適用します。
- `web_search`、`x_search`、`code_execution` は OpenClaw ツールとして公開されています。OpenClaw はすべてのネイティブツールを毎回のチャットターンに添付するのではなく、各ツールリクエスト内で必要な特定の xAI ビルトインを有効にします。
- `x_search` と `code_execution` は、コアモデルランタイムにハードコードされているのではなく、バンドル済みの xAI プラグインが所有しています。
- `code_execution` はリモートの xAI サンドボックス実行であり、ローカルの [`exec`](/tools/exec) ではありません。
- プロバイダーの概要については、[モデルプロバイダー](/providers/index)を参照してください。
