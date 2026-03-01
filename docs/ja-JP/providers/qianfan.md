---
summary: "Qianfanの統合APIを使って多くのモデルをOpenClawで利用する"
read_when:
  - 多くのLLMに単一のAPIキーで利用したい場合
  - Baidu Qianfanのセットアップガイダンスが必要な場合
title: "Qianfan"
---

# Qianfanプロバイダーガイド

QianfanはBaiduのMaaSプラットフォームで、単一のエンドポイントとAPIキーで多くのモデルへのリクエストをルーティングする**統合API**を提供しています。OpenAI互換のため、ほとんどのOpenAI SDKはベースURLを切り替えるだけで動作します。

## 前提条件

1. Qianfan APIアクセスが有効なBaidu Cloudアカウント
2. Qianfanコンソールからのkey
3. システムにインストールされたOpenClaw

## APIキーの取得

1. [Qianfanコンソール](https://console.bce.baidu.com/qianfan/ais/console/apiKey) にアクセス
2. 新しいアプリケーションを作成するか、既存のものを選択
3. APIキーを生成（形式: `bce-v3/ALTAK-...`）
4. OpenClawで使用するためにAPIキーをコピー

## CLIセットアップ

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## 関連ドキュメント

- [OpenClaw設定](/gateway/configuration)
- [モデルプロバイダー](/concepts/model-providers)
- [エージェントセットアップ](/concepts/agent)
- [Qianfan APIドキュメント](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
