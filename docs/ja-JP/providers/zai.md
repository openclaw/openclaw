---
summary: "Z.AI（GLMモデル）をOpenClawで使用する"
read_when:
  - OpenClawでZ.AI / GLMモデルを使いたい場合
  - シンプルなZAI_API_KEYのセットアップが必要な場合
title: "Z.AI"
---

# Z.AI

Z.AIは**GLM**モデルのAPIプラットフォームです。GLM用のREST APIを提供し、APIキーで認証します。Z.AIコンソールでAPIキーを作成してください。OpenClawはZ.AI APIキーで `zai` プロバイダーを使用します。

## CLIセットアップ

```bash
openclaw onboard --auth-choice zai-api-key
# または非インタラクティブ
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## 設定スニペット

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5" } } },
}
```

## 注意事項

- GLMモデルは `zai/<model>`（例: `zai/glm-5`）として利用可能です。
- `tool_stream` はZ.AIのツール呼び出しストリーミングに対してデフォルトで有効になっています。無効にするには `agents.defaults.models["zai/<model>"].params.tool_stream` を `false` に設定してください。
- モデルファミリーの概要については [/providers/glm](/providers/glm) を参照してください。
- Z.AIはAPIキーによるBearer認証を使用します。
