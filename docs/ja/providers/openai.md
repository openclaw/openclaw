---
summary: "OpenClaw で API キーまたは Codex サブスクリプションを使用して OpenAI を利用します"
read_when:
  - OpenClaw で OpenAI モデルを使用したい場合
  - API キーではなく Codex サブスクリプション認証を使用したい場合
title: "OpenAI"
x-i18n:
  source_path: providers/openai.md
  source_hash: 6d78698351c3d2f5
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:22:52Z
---

# OpenAI

OpenAI は GPT モデル向けの開発者 API を提供しています。Codex は、サブスクリプションによるアクセスのための **ChatGPT サインイン**、または従量課金アクセスのための **API キー** サインインをサポートします。Codex クラウドでは ChatGPT サインインが必要です。

## オプション A: OpenAI API キー（OpenAI Platform）

**最適な用途:** 直接的な API アクセスと従量課金。
OpenAI ダッシュボードから API キーを取得してください。

### CLI セットアップ

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### 設定スニペット

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## オプション B: OpenAI Code（Codex）サブスクリプション

**最適な用途:** API キーではなく ChatGPT/Codex サブスクリプションアクセスを使用する場合。
Codex クラウドでは ChatGPT サインインが必要ですが、Codex CLI は ChatGPT または API キーでのサインインをサポートします。

### CLI セットアップ（Codex OAuth）

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### 設定スニペット（Codex サブスクリプション）

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## 注記

- モデル参照は常に `provider/model` を使用します（[/concepts/models](/concepts/models) を参照）。
- 認証の詳細および再利用ルールは [/concepts/oauth](/concepts/oauth) に記載されています。
