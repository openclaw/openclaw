---
summary: "Voice Call プラグイン: Twilio/Telnyx/Plivo 経由の発信・着信通話（プラグインのインストール + 設定 + CLI）"
read_when:
  - OpenClaw から音声通話を発信したい場合
  - voice-call プラグインを設定または開発している場合
title: "Voice Call プラグイン"
---

# Voice Call（プラグイン）

プラグインを通じた OpenClaw の音声通話機能です。発信通知と着信ポリシーによるマルチターン会話をサポートします。

現在のプロバイダー:

- `twilio`（Programmable Voice + Media Streams）
- `telnyx`（Call Control v2）
- `plivo`（Voice API + XML transfer + GetInput speech）
- `mock`（開発/ネットワークなし）

基本的な流れ:

- プラグインをインストール
- Gateway を再起動
- `plugins.entries.voice-call.config` の下で設定
- `openclaw voicecall ...` または `voice_call` ツールを使用

## 実行場所（ローカル vs リモート）

Voice Call プラグインは **Gateway プロセス内**で実行されます。

リモート Gateway を使用する場合は、**Gateway を実行しているマシン**にプラグインをインストール/設定してから、Gateway を再起動してロードしてください。

## インストール

### オプション A: npm からインストール（推奨）

```bash
openclaw plugins install @openclaw/voice-call
```

その後、Gateway を再起動してください。

### オプション B: ローカルフォルダからインストール（開発、コピーなし）

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

その後、Gateway を再起動してください。

## 設定

`plugins.entries.voice-call.config` の下で設定を行います。

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio", // または "telnyx" | "plivo" | "mock"
          fromNumber: "+15550001234",
          toNumber: "+15550005678",

          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "...",
          },

          telnyx: {
            apiKey: "...",
            connectionId: "...",
            // Telnyx Mission Control Portal の Telnyx Webhook 公開鍵
            // （Base64 文字列; TELNYX_PUBLIC_KEY 経由でも設定可能）
            publicKey: "...",
          },

          plivo: {
            authId: "MAxxxxxxxxxxxxxxxxxxxx",
            authToken: "...",
          },

          // Webhook サーバー
          serve: {
            port: 3334,
            path: "/voice/webhook",
          },

          // Webhook セキュリティ（トンネル/プロキシでの使用を推奨）
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
            trustedProxyIPs: ["100.64.0.1"],
          },

          // 公開方法（いずれか一つを選択）
          // publicUrl: "https://example.ngrok.app/voice/webhook",
          // tunnel: { provider: "ngrok" },
          // tailscale: { mode: "funnel", path: "/voice/webhook" }

          outbound: {
            defaultMode: "notify", // notify | conversation
          },

          streaming: {
            enabled: true,
            streamPath: "/voice/stream",
            preStartTimeoutMs: 5000,
            maxPendingConnections: 32,
            maxPendingConnectionsPerIp: 4,
            maxConnections: 128,
          },
        },
      },
    },
  },
}
```

注意事項:

- Twilio/Telnyx は**公開到達可能な** Webhook URL が必要です。
- Plivo は**公開到達可能な** Webhook URL が必要です。
- `mock` はローカル開発用プロバイダーです（ネットワーク呼び出しなし）。
- Telnyx は `skipSignatureVerification` が true でない限り、`telnyx.publicKey`（または `TELNYX_PUBLIC_KEY`）が必要です。
- `skipSignatureVerification` はローカルテスト専用です。
- ngrok の無料ティアを使用する場合は、`publicUrl` に正確な ngrok URL を設定してください。署名の検証は常に強制されます。
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` は、`tunnel.provider="ngrok"` かつ `serve.bind` がループバック（ngrok ローカルエージェント）の場合に**のみ**、無効な署名を持つ Twilio Webhook を許可します。ローカル開発専用です。
- ngrok 無料ティアの URL は変更されたり中間ページが挿入されたりすることがあります。`publicUrl` がずれると、Twilio の署名が失敗します。本番環境では安定したドメインまたは Tailscale Funnel を優先してください。
- ストリーミングセキュリティのデフォルト:
  - `streaming.preStartTimeoutMs`: 有効な `start` フレームを送信しないソケットを閉じます。
  - `streaming.maxPendingConnections`: 認証前の保留中ソケットの合計数を制限します。
  - `streaming.maxPendingConnectionsPerIp`: ソース IP ごとの認証前の保留中ソケット数を制限します。
  - `streaming.maxConnections`: 開いているメディアストリームソケットの合計数（保留中 + アクティブ）を制限します。

## 古い通話の削除（Stale Call Reaper）

`staleCallReaperSeconds` を使用して、終端 Webhook を受信しなかった通話を終了させます（例: 完了しなかった通知モードの通話）。デフォルトは `0`（無効）です。

推奨範囲:

- **本番環境:** 通知スタイルのフローには `120`〜`300` 秒。
- 通常の通話が完了できるよう、この値は `maxDurationSeconds` より**大きく**してください。良い出発点は `maxDurationSeconds + 30〜60` 秒です。

例:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          maxDurationSeconds: 300,
          staleCallReaperSeconds: 360,
        },
      },
    },
  },
}
```

## Webhook セキュリティ

プロキシまたはトンネルが Gateway の前に配置されている場合、プラグインは署名検証のために公開 URL を再構築します。これらのオプションは、どの転送ヘッダーを信頼するかを制御します。

`webhookSecurity.allowedHosts` は転送ヘッダーからのホストを許可リストに登録します。

`webhookSecurity.trustForwardingHeaders` は許可リストなしで転送ヘッダーを信頼します。

`webhookSecurity.trustedProxyIPs` は、リクエストのリモート IP がリストと一致する場合にのみ転送ヘッダーを信頼します。

Webhook のリプレイ保護は Twilio と Plivo で有効になっています。リプレイされた有効な Webhook リクエストは応答されますが、副作用はスキップされます。

Twilio の会話ターンには `<Gather>` コールバックにターンごとのトークンが含まれるため、古い/リプレイされた音声コールバックは新しい保留中のトランスクリプトターンを満たすことができません。

安定した公開ホストを使用した例:

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

## 通話用 TTS

Voice Call は、通話中のストリーミング音声にコアの `messages.tts` 設定（OpenAI または ElevenLabs）を使用します。プラグイン設定の下で**同じ形式**でオーバーライドできます。`messages.tts` とディープマージされます。

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

注意事項:

- **Edge TTS は音声通話では無視されます**（電話音声には PCM が必要; Edge の出力は信頼性がありません）。
- Twilio メディアストリーミングが有効な場合はコア TTS が使用されます。それ以外の場合は、プロバイダーのネイティブ音声にフォールバックします。

### その他の例

コア TTS のみを使用（オーバーライドなし）:

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

通話のみ ElevenLabs にオーバーライド（他はコアのデフォルトを維持）:

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

通話のみ OpenAI モデルをオーバーライド（ディープマージの例）:

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

着信ポリシーのデフォルトは `disabled` です。着信通話を有効にするには以下を設定してください。

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

自動応答はエージェントシステムを使用します。以下でチューニングできます。

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

ツール名: `voice_call`

アクション:

- `initiate_call`（message、to?、mode?）
- `continue_call`（callId、message）
- `speak_to_user`（callId、message）
- `end_call`（callId）
- `get_status`（callId）

このリポジトリには `skills/voice-call/SKILL.md` に対応するスキルドキュメントが含まれています。

## Gateway RPC

- `voicecall.initiate`（`to?`、`message`、`mode?`）
- `voicecall.continue`（`callId`、`message`）
- `voicecall.speak`（`callId`、`message`）
- `voicecall.end`（`callId`）
- `voicecall.status`（`callId`）
