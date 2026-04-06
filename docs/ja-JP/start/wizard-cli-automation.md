---
read_when:
    - スクリプトや CI でオンボーディングを自動化する場合
    - 特定のプロバイダー向けの非対話型の例が必要な場合
sidebarTitle: CLI automation
summary: OpenClaw CLI のスクリプトによるオンボーディングとエージェントセットアップ
title: CLI 自動化
x-i18n:
    generated_at: "2026-04-02T08:38:33Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: db40479549ae1d9d8149f2b85441ff82954ff2aad44cb203ac04e8b501e05276
    source_path: start/wizard-cli-automation.md
    workflow: 15
---

# CLI 自動化

`--non-interactive` を使用して `openclaw onboard` を自動化できます。

<Note>
`--json` は非対話モードを意味しません。スクリプトでは `--non-interactive`（および `--workspace`）を使用してください。
</Note>

## 基本的な非対話型の例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --secret-input-mode plaintext \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

マシンリーダブルなサマリーを得るには `--json` を追加してください。

`--secret-input-mode ref` を使用すると、プレーンテキスト値の代わりに環境変数ベースの参照を認証プロファイルに保存できます。
オンボーディングフローでは、環境変数参照と設定済みプロバイダー参照（`file` または `exec`）の対話的な選択も可能です。

非対話型の `ref` モードでは、プロバイダーの環境変数がプロセス環境に設定されている必要があります。
対応する環境変数なしにインラインキーフラグを渡すと、即座にエラーになります。

例：

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice openai-api-key \
  --secret-input-mode ref \
  --accept-risk
```

## プロバイダー固有の例

<AccordionGroup>
  <Accordion title="Gemini の例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI の例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway の例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway の例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Moonshot の例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Mistral の例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice mistral-api-key \
      --mistral-api-key "$MISTRAL_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic の例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode の例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
    Go カタログを使用するには `--auth-choice opencode-go --opencode-go-api-key "$OPENCODE_API_KEY"` に変更してください。
  </Accordion>
  <Accordion title="Ollama の例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ollama \
      --custom-model-id "qwen3.5:27b" \
      --accept-risk \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="カスタムプロバイダーの例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice custom-api-key \
      --custom-base-url "https://llm.example.com/v1" \
      --custom-model-id "foo-large" \
      --custom-api-key "$CUSTOM_API_KEY" \
      --custom-provider-id "my-custom" \
      --custom-compatibility anthropic \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```

    `--custom-api-key` は省略可能です。省略した場合、オンボーディングは `CUSTOM_API_KEY` を確認します。

    ref モードの例：

    ```bash
    export CUSTOM_API_KEY="your-key"
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice custom-api-key \
      --custom-base-url "https://llm.example.com/v1" \
      --custom-model-id "foo-large" \
      --secret-input-mode ref \
      --custom-provider-id "my-custom" \
      --custom-compatibility anthropic \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```

    このモードでは、オンボーディングは `apiKey` を `{ source: "env", provider: "default", id: "CUSTOM_API_KEY" }` として保存します。

  </Accordion>
</AccordionGroup>

## 別のエージェントを追加する

`openclaw agents add <name>` を使用して、独自のワークスペース、セッション、認証プロファイルを持つ別のエージェントを作成できます。`--workspace` なしで実行するとウィザードが起動します。

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

設定される内容：

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

注意事項：

- デフォルトのワークスペースは `~/.openclaw/workspace-<agentId>` に従います。
- 受信メッセージをルーティングするには `bindings` を追加してください（ウィザードでも設定できます）。
- 非対話型フラグ：`--model`、`--agent-dir`、`--bind`、`--non-interactive`。

## 関連ドキュメント

- オンボーディングハブ：[セットアップウィザード（CLI）](/start/wizard)
- 完全なリファレンス：[CLI セットアップ リファレンス](/start/wizard-cli-reference)
- コマンドリファレンス：[`openclaw onboard`](/cli/onboard)
