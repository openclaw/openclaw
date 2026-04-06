---
read_when:
    - Perplexity をウェブ検索プロバイダーとして設定したい場合
    - Perplexity APIキーまたは OpenRouter プロキシのセットアップが必要な場合
summary: Perplexity ウェブ検索プロバイダーのセットアップ（APIキー、検索モード、フィルタリング）
title: Perplexity（プロバイダー）
x-i18n:
    generated_at: "2026-04-02T07:50:45Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: df9082d15d6a36a096e21efe8cee78e4b8643252225520f5b96a0b99cf5a7a4b
    source_path: providers/perplexity-provider.md
    workflow: 15
---

# Perplexity（ウェブ検索プロバイダー）

Perplexity プラグインは、Perplexity Search API または OpenRouter 経由の Perplexity Sonar を通じてウェブ検索機能を提供します。

<Note>
このページでは Perplexity の**プロバイダー**セットアップについて説明します。Perplexity の**ツール**（エージェントがどのように使用するか）については、[Perplexity ツール](/tools/perplexity-search)を参照してください。
</Note>

- タイプ: ウェブ検索プロバイダー（モデルプロバイダーではありません）
- 認証: `PERPLEXITY_API_KEY`（直接）または `OPENROUTER_API_KEY`（OpenRouter 経由）
- 設定パス: `plugins.entries.perplexity.config.webSearch.apiKey`

## クイックスタート

1. APIキーを設定します:

```bash
openclaw configure --section web
```

または直接設定します:

```bash
openclaw config set plugins.entries.perplexity.config.webSearch.apiKey "pplx-xxxxxxxxxxxx"
```

2. 設定が完了すると、エージェントはウェブ検索時に自動的に Perplexity を使用します。

## 検索モード

プラグインはAPIキーのプレフィックスに基づいてトランスポートを自動選択します:

| キープレフィックス | トランスポート                    | 機能                                         |
| ---------- | ---------------------------- | ------------------------------------------------ |
| `pplx-`    | ネイティブ Perplexity Search API | 構造化された結果、ドメイン/言語/日付フィルター |
| `sk-or-`   | OpenRouter (Sonar)           | 引用付きのAI生成回答            |

## ネイティブAPIフィルタリング

ネイティブ Perplexity API（`pplx-` キー）を使用する場合、検索では以下をサポートします:

- **国**: 2文字の国コード
- **言語**: ISO 639-1 言語コード
- **日付範囲**: 日、週、月、年
- **ドメインフィルター**: 許可リスト/拒否リスト（最大20ドメイン）
- **コンテンツ予算**: `max_tokens`、`max_tokens_per_page`

## 環境変数に関する注意

Gateway ゲートウェイがデーモン（launchd/systemd）として実行されている場合、`PERPLEXITY_API_KEY` がそのプロセスで利用可能であることを確認してください（例: `~/.openclaw/.env` または `env.shellEnv` 経由）。
