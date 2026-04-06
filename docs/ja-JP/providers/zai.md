---
read_when:
    - OpenClawでZ.AI / GLMモデルを使用したい場合
    - シンプルなZAI_API_KEYの設定が必要な場合
summary: Z.AI（GLMモデル）をOpenClawで使用する
title: Z.AI
x-i18n:
    generated_at: "2026-04-02T07:51:06Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 79ea8f3d6c286b5fef090e54257eb7c60c82b29630cee3f54e96161e55349bf5
    source_path: providers/zai.md
    workflow: 15
---

# Z.AI

Z.AIは**GLM**モデルのAPIプラットフォームです。GLM用のREST APIを提供し、認証にはAPIキーを使用します。Z.AIコンソールでAPIキーを作成してください。OpenClawはZ.AIのAPIキーを使用して`zai`プロバイダーを利用します。

## CLIセットアップ

```bash
# Coding Plan Global、Coding Planユーザーに推奨
openclaw onboard --auth-choice zai-coding-global

# Coding Plan CN（中国リージョン）、Coding Planユーザーに推奨
openclaw onboard --auth-choice zai-coding-cn

# 汎用API
openclaw onboard --auth-choice zai-global

# 汎用API CN（中国リージョン）
openclaw onboard --auth-choice zai-cn
```

## 設定スニペット

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5" } } },
}
```

## 注意事項

- GLMモデルは`zai/<model>`として利用できます（例：`zai/glm-5`）。
- Z.AIのツール呼び出しストリーミングでは、デフォルトで`tool_stream`が有効になっています。無効にするには、`agents.defaults.models["zai/<model>"].params.tool_stream`を`false`に設定してください。
- モデルファミリーの概要については、[/providers/glm](/providers/glm)を参照してください。
- Z.AIはAPIキーを使用したBearer認証を使用します。
