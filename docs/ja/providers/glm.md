---
summary: "GLM モデルファミリーの概要と OpenClaw での使用方法"
read_when:
  - OpenClaw で GLM モデルを使用したい場合
  - モデルの命名規則とセットアップが必要な場合
title: "GLM モデル"
---

# GLM モデル

GLM は Z.AI プラットフォームを通じて提供される **モデルファミリー**（企業ではありません）です。OpenClaw では、GLM
モデルは `zai` プロバイダーおよび `zai/glm-4.7` のようなモデル ID を介して利用します。 OpenClawでは、GLM
モデルには`zai`プロバイダ経由でアクセスし、`zai/glm-4.7`のようなモデルIDがあります。

## CLI セットアップ

```bash
openclaw onboard --auth-choice zai-api-key
```

## 設定スニペット

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## 注記

- GLM のバージョンや提供状況は変更される可能性があります。最新情報については Z.AI のドキュメントを確認してください。
- モデル ID の例には `glm-4.7` および `glm-4.6` があります。
- プロバイダーの詳細については [/providers/zai](/providers/zai) を参照してください。
