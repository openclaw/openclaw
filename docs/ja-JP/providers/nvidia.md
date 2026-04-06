---
read_when:
    - OpenClawでNVIDIAモデルを使いたい
    - NVIDIA_API_KEYのセットアップが必要
summary: OpenClawでNVIDIAのOpenAI互換APIを使用する
title: NVIDIA
x-i18n:
    generated_at: "2026-04-02T08:58:26Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 81e7a1b6cd6821b68db9c71b864d36023b1ccfad1641bf88e2bc2957782edf8b
    source_path: providers/nvidia.md
    workflow: 15
---

# NVIDIA

NVIDIAはNemotronおよびNeMoモデル向けに`https://integrate.api.nvidia.com/v1`でOpenAI互換APIを提供している。[NVIDIA NGC](https://catalog.ngc.nvidia.com/)からAPIキーを取得して認証する。

## CLIセットアップ

キーを一度エクスポートしてから、オンボーディングを実行しNVIDIAモデルを設定する：

```bash
export NVIDIA_API_KEY="nvapi-..."
openclaw onboard --auth-choice skip
openclaw models set nvidia/nvidia/llama-3.1-nemotron-70b-instruct
```

`--token`を使用する場合、シェル履歴や`ps`出力に残る点に注意。可能であれば環境変数の使用を推奨する。

## 設定スニペット

```json5
{
  env: { NVIDIA_API_KEY: "nvapi-..." },
  models: {
    providers: {
      nvidia: {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        api: "openai-completions",
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "nvidia/nvidia/llama-3.1-nemotron-70b-instruct" },
    },
  },
}
```

## モデルID

- `nvidia/llama-3.1-nemotron-70b-instruct`（デフォルト）
- `meta/llama-3.3-70b-instruct`
- `nvidia/mistral-nemo-minitron-8b-8k-instruct`

## 注意事項

- OpenAI互換の`/v1`エンドポイント。NVIDIA NGCのAPIキーを使用する。
- `NVIDIA_API_KEY`が設定されるとプロバイダーが自動的に有効になる。静的デフォルト値（131,072トークンのコンテキストウィンドウ、最大4,096トークン）を使用する。
