---
summary: "OpenClaw で Z.AI（GLM モデル）を使用します"
read_when:
  - OpenClaw で Z.AI / GLM モデルを使用したい場合
  - シンプルな ZAI_API_KEY のセットアップが必要な場合
title: "Z.AI"
---

# Z.AI

Z.AI は **GLM** モデルの API プラットフォームです。 GLMにRESTAPIを提供し、認証にAPIキー
を使用します。 Z.AI コンソールで API キーを作成します。 Z.AI は **GLM** モデル向けの API プラットフォームです。GLM 用の REST API を提供し、認証には API キーを使用します。Z.AI コンソールで API キーを作成してください。OpenClaw は Z.AI の API キーとともに `zai` プロバイダーを使用します。

## CLI セットアップ

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## 設定スニペット

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## 注記

- GLM モデルは `zai/<model>` として利用できます（例: `zai/glm-4.7`）。
- モデルファミリーの概要については [/providers/glm](/providers/glm) を参照してください。
- Z.AI は API キーを使用した Bearer 認証を使用します。
