---
summary: "OpenClawでZ.AI（GLMモデル）を使用する"
read_when:
  - OpenClawでZ.AI / GLMモデルを使いたい
  - シンプルなZAI_API_KEYのセットアップが必要
title: "Z.AI"
x-i18n:
  source_path: "docs/providers/zai.md"
  generated_at: "2026-03-05T10:01:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
---

# Z.AI

Z.AIは**GLM**モデルのAPIプラットフォームです。GLM向けのREST APIを提供し、認証にはAPIキーを使用します。Z.AIコンソールでAPIキーを作成してください。OpenClawは`zai`プロバイダーとZ.AI APIキーを使用します。

## CLIセットアップ

```bash
openclaw onboard --auth-choice zai-api-key
# または非対話式
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## 設定スニペット

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5" } } },
}
```

## 備考

- GLMモデルは`zai/<model>`として利用できます（例：`zai/glm-5`）。
- Z.AIのツールコールストリーミングには、デフォルトで`tool_stream`が有効になっています。無効にするには、`agents.defaults.models["zai/<model>"].params.tool_stream`を`false`に設定してください。
- モデルファミリーの概要は[/providers/glm](/providers/glm)を参照してください。
- Z.AIはAPIキーによるBearer認証を使用します。
