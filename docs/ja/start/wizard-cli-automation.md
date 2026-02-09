---
summary: "OpenClaw CLI のスクリプト化されたオンボーディングとエージェントセットアップ"
read_when:
  - スクリプトや CI でオンボーディングを自動化する場合
  - 特定のプロバイダー向けに非対話型の例が必要な場合
title: "CLI 自動化"
sidebarTitle: "CLI automation"
---

# CLI 自動化

`--non-interactive` を使用して `openclaw onboard` を自動化します。

<Note>

`--json` は非対話型モードを意味するものではありません。スクリプトでは `--non-interactive`（および `--workspace`）を使用してください。
 スクリプトには `--非対話型` (と `--workspace` )を使用します。
</Note>

## ベースラインの非対話型例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

機械可読なサマリーを得るには `--json` を追加します。

## プロバイダー別の例

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
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
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

## 別のエージェントを追加する

`openclaw agents add <name>` を使用すると、独自のワークスペース、セッション、認証プロファイルを持つ別のエージェントを作成できます。`--workspace` を指定せずに実行すると、ウィザードが起動します。 `--workspace` なしで実行すると、ウィザードが起動します。

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

設定される内容:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

注記:

- デフォルトのワークスペースは `~/.openclaw/workspace-<agentId>` に従います。
- 受信メッセージをルーティングするには `bindings` を追加します（ウィザードでも設定可能です）。
- 非対話型フラグ: `--model`, `--agent-dir`, `--bind`, `--non-interactive`。

## 関連ドキュメント

- オンボーディング ハブ: [オンボーディング ウィザード（CLI）](/start/wizard)
- 完全なリファレンス: [CLI オンボーディング リファレンス](/start/wizard-cli-reference)
- コマンド リファレンス: [`openclaw onboard`](/cli/onboard)
