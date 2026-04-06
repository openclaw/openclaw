---
read_when:
    - 単一のAPIキーで多数のLLMを利用したい場合
    - Baidu Qianfanのセットアップガイドが必要な場合
summary: QianfanのユニファイドAPIを使用して、OpenClawで多数のモデルにアクセスできます
title: Qianfan
x-i18n:
    generated_at: "2026-04-02T07:50:41Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 2ca710b422f190b65d23db51a3219f0abd67074fb385251efeca6eae095d02e0
    source_path: providers/qianfan.md
    workflow: 15
---

# Qianfan プロバイダーガイド

QianfanはBaiduのMaaSプラットフォームで、単一のエンドポイントとAPIキーの背後にある多数のモデルにリクエストをルーティングする**ユニファイドAPI**を提供します。OpenAI互換のため、ベースURLを切り替えるだけでほとんどのOpenAI SDKが動作します。

## 前提条件

1. Qianfan APIアクセスが有効なBaidu Cloudアカウント
2. Qianfanコンソールから取得したAPIキー
3. システムにインストール済みのOpenClaw

## APIキーの取得

1. [Qianfanコンソール](https://console.bce.baidu.com/qianfan/ais/console/apiKey)にアクセスします
2. 新しいアプリケーションを作成するか、既存のものを選択します
3. APIキーを生成します（形式: `bce-v3/ALTAK-...`）
4. OpenClawで使用するためにAPIキーをコピーします

## CLIセットアップ

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## 関連ドキュメント

- [OpenClaw設定](/gateway/configuration)
- [モデルプロバイダー](/concepts/model-providers)
- [エージェントセットアップ](/concepts/agent)
- [Qianfan APIドキュメント](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
