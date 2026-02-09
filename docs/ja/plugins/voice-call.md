---
summary: "音声通話プラグイン：Twilio/Telnyx/Plivo による発信・着信通話（プラグインのインストール＋設定＋ CLI）"
read_when:
  - OpenClaw から発信の音声通話を行いたい場合
  - voice-call プラグインを設定または開発している場合
title: "音声通話プラグイン"
---

# Voice Call（plugin）

OpenClaw 向けの音声通話を提供するプラグインです。発信通知および、着信ポリシーに基づくマルチターンの会話をサポートします。 3. アウトバウンド通知と、
インバウンドポリシーを伴うマルチターン会話をサポートします。

現在のプロバイダー：

- `twilio`（Programmable Voice + Media Streams）
- `telnyx`（Call Control v2）
- `plivo`（Voice API + XML transfer + GetInput speech）
- `mock`（dev／ネットワークなし）

クイックな理解モデル：

- プラグインをインストール
- Gateway を再起動
- `plugins.entries.voice-call.config` 配下で設定
- `openclaw voicecall ...` または `voice_call` ツールを使用

## 実行場所（ローカル vs リモート）

音声通話プラグインは **Gateway プロセス内** で実行されます。

リモート Gateway を使用する場合は、**Gateway を実行しているマシン** にプラグインをインストール／設定し、その後 Gateway を再起動して読み込んでください。

## インストール

### オプション A：npm からインストール（推奨）

```bash
openclaw plugins install @openclaw/voice-call
```

その後、Gateway を再起動してください。

### オプション B：ローカルフォルダーからインストール（開発向け、コピーなし）

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

その後、Gateway を再起動してください。

## 設定

`plugins.entries.voice-call.config` 配下に設定します：

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio", // or "telnyx" | "plivo" | "mock"
          fromNumber: "+15550001234",
          toNumber: "+15550005678",

          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "...",
          },

          plivo: {
            authId: "MAxxxxxxxxxxxxxxxxxxxx",
            authToken: "...",
          },

          // Webhook server
          serve: {
            port: 3334,
            path: "/voice/webhook",
          },

          // Webhook security (recommended for tunnels/proxies)
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
            trustedProxyIPs: ["100.64.0.1"],
          },

          // Public exposure (pick one)
          // publicUrl: "https://example.ngrok.app/voice/webhook",
          // tunnel: { provider: "ngrok" },
          // tailscale: { mode: "funnel", path: "/voice/webhook" }

          outbound: {
            defaultMode: "notify", // notify | conversation
          },

          streaming: {
            enabled: true,
            streamPath: "/voice/stream",
          },
        },
      },
    },
  },
}
```

注記：

- Twilio／Telnyx では **公開到達可能** な Webhook URL が必要です。
- Plivo でも **公開到達可能** な Webhook URL が必要です。
- `mock` はローカル開発用のプロバイダーです（ネットワーク呼び出しなし）。
- `skipSignatureVerification` はローカルテスト専用です。
- ngrok の free tier を使用する場合は、`publicUrl` に正確な ngrok URL を設定してください。署名検証は常に有効です。
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` は、`tunnel.provider="ngrok"` かつ `serve.bind` がループバック（ngrok のローカルエージェント）の場合 **のみ**、無効な署名の Twilio Webhook を許可します。ローカル開発専用で使用してください。 ローカル開発者のみに使用します。
- ngrok の free tier URL は変更されたり、インタースティシャル挙動が追加されたりする場合があります。`publicUrl` が変動すると Twilio の署名検証に失敗します。本番環境では、安定したドメインまたは Tailscale の funnel を推奨します。 生産のために、安定したドメインまたはテイルスケールの漏斗を好む。

## Webhook のセキュリティ

Gateway の前段にプロキシやトンネルがある場合、プラグインは署名検証のために公開 URL を再構築します。以下のオプションで、どの転送ヘッダーを信頼するかを制御します。 これらのオプションは、どの転送された
ヘッダが信頼されるかを制御します。

`webhookSecurity.allowedHosts` は、転送ヘッダーからのホストを許可リストに基づいて許可します。

`webhookSecurity.trustForwardingHeaders` は、許可リストなしで転送ヘッダーを信頼します。

`webhookSecurity.trustedProxyIPs` は、リクエストのリモート IP がリストに一致する場合にのみ転送ヘッダーを信頼します。

安定した公開ホストを使用する例：

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          publicUrl: "https://voice.example.com/voice/webhook",
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
          },
        },
      },
    },
  },
}
```

## 通話向け TTS

音声通話では、通話中のストリーミング音声に対してコアの `messages.tts` 設定（OpenAI または ElevenLabs）を使用します。プラグイン設定配下で **同一の形状** のまま上書きすることも可能で、`messages.tts` とディープマージされます。 プラグインの設定では
**同じ図形** でオーバーライドできます — `messages.tts` と深くマージできます。

```json5
{
  tts: {
    provider: "elevenlabs",
    elevenlabs: {
      voiceId: "pMsXgVXv3BLzUgSXRplE",
      modelId: "eleven_multilingual_v2",
    },
  },
}
```

注記：

- **音声通話では Edge TTS は無視されます**（電話音声は PCM が必要であり、Edge の出力は信頼性が低いためです）。
- Twilio のメディアストリーミングが有効な場合はコア TTS が使用されます。それ以外の場合、通話はプロバイダーのネイティブ音声にフォールバックします。

### 追加例

コア TTS のみを使用（上書きなし）：

```json5
{
  messages: {
    tts: {
      provider: "openai",
      openai: { voice: "alloy" },
    },
  },
}
```

通話時のみ ElevenLabs に上書き（他はコア既定を維持）：

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            provider: "elevenlabs",
            elevenlabs: {
              apiKey: "elevenlabs_key",
              voiceId: "pMsXgVXv3BLzUgSXRplE",
              modelId: "eleven_multilingual_v2",
            },
          },
        },
      },
    },
  },
}
```

通話向けに OpenAI のモデルのみを上書き（ディープマージの例）：

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            openai: {
              model: "gpt-4o-mini-tts",
              voice: "marin",
            },
          },
        },
      },
    },
  },
}
```

## 着信通話

インバウンドポリシーのデフォルトは `disabled` です。 着信を有効にするには、以下を設定します。

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

自動応答はエージェントシステムを使用します。以下で調整できます： チューニング:

- `responseModel`
- `responseSystemPrompt`
- `responseTimeoutMs`

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall speak --call-id <id> --message "One moment"
openclaw voicecall end --call-id <id>
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw voicecall expose --mode funnel
```

## エージェントツール

ツール名：`voice_call`

アクション：

- `initiate_call`（message, to?, mode?）
- `continue_call`（callId, message）
- `speak_to_user`（callId, message）
- `end_call`（callId）
- `get_status`（callId）

このリポジトリには、`skills/voice-call/SKILL.md` に対応する Skills ドキュメントが同梱されています。

## Gateway RPC

- `voicecall.initiate`（`to?`, `message`, `mode?`）
- `voicecall.continue`（`callId`, `message`）
- `voicecall.speak`（`callId`, `message`）
- `voicecall.end`（`callId`）
- `voicecall.status`（`callId`）
