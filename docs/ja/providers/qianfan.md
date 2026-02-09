---
summary: "Qianfan の統合 API を使用して、OpenClaw で多数のモデルにアクセスします"
read_when:
  - 多数の LLM に対して単一の API キーを使いたい場合
  - Baidu Qianfan のセットアップ手順が必要な場合
title: "Qianfan"
---

# Qianfan プロバイダーガイド

Qianfan は Baidu の MaaS プラットフォームであり、**統合 API** を提供して、単一のエンドポイントと API キーの背後で多数のモデルへリクエストをルーティングします。OpenAI 互換のため、base URL を切り替えるだけで、ほとんどの OpenAI SDK が動作します。 OpenAIと互換性があるため、ほとんどのOpenAISDKはベースURLを切り替えることで動作します。

## 前提条件

1. Qianfan API へのアクセス権を持つ Baidu Cloud アカウント
2. Qianfan コンソールで発行した API キー
3. システムに OpenClaw がインストールされていること

## API キーの取得

1. [Qianfan Console](https://console.bce.baidu.com/qianfan/ais/console/apiKey) にアクセスします
2. 新しいアプリケーションを作成するか、既存のものを選択します
3. API キーを生成します（形式: `bce-v3/ALTAK-...`）
4. OpenClaw で使用するために API キーをコピーします

## CLI セットアップ

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## 関連ドキュメント

- [OpenClaw 設定](/gateway/configuration)
- [モデルプロバイダー](/concepts/model-providers)
- [エージェントのセットアップ](/concepts/agent)
- [Qianfan API ドキュメント](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
