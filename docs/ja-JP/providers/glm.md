---
summary: "GLMモデルファミリーの概要とOpenClawでの使い方"
read_when:
  - OpenClawでGLMモデルを使いたい場合
  - モデルの命名規則とセットアップが必要な場合
title: "GLMモデル"
---

# GLMモデル

GLMはZ.AIプラットフォームを通じて利用可能な**モデルファミリー**（企業名ではありません）です。OpenClawではGLMモデルは `zai` プロバイダーを通じてアクセスし、`zai/glm-5` のようなモデルIDを使用します。

## CLIセットアップ

```bash
openclaw onboard --auth-choice zai-api-key
```

## 設定スニペット

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5" } } },
}
```

## 注意事項

- GLMのバージョンと利用可能性は変わることがあります。最新情報はZ.AIのドキュメントを確認してください。
- モデルIDの例: `glm-5`、`glm-4.7`、`glm-4.6`。
- プロバイダーの詳細については [/providers/zai](/providers/zai) を参照してください。
