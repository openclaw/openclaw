---
read_when:
    - OpenClawから発信通話を行いたい場合
    - voice-callプラグインを設定または開発している場合
summary: 'Voice Callプラグイン: Twilio/Telnyx/Plivoによる発信・着信通話（プラグインのインストール・設定・CLI）'
title: Voice Callプラグイン
x-i18n:
    generated_at: "2026-04-02T08:37:27Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 4d273675ec67cecab47c252e5f5cc31fe6fca8fa0d649668565eaefbb9a9bbf4
    source_path: plugins/voice-call.md
    workflow: 15
---

# Voice Call（プラグイン）

プラグインによるOpenClawの音声通話機能。発信通知およびインバウンドポリシーを備えたマルチターン会話をサポートします。

現在のプロバイダー:

- `twilio`（Programmable Voice + Media Streams）
- `telnyx`（Call Control v2）
- `plivo`（Voice API + XML transfer + GetInput speech）
- `mock`（開発用/ネットワーク不要）

概要:

- プラグインをインストール
- Gateway ゲートウェイを再起動
- `plugins.entries.voice-call.config` で設定
- `openclaw voicecall ...` またはツール `voice_call` を使用

## 実行場所（ローカル vs リモート）

Voice Callプラグインは **Gateway ゲートウェイのプロセス内** で動作します。

リモートGateway ゲートウェイを使用する場合は、**Gateway ゲートウェイを実行しているマシン** でプラグインをインストール・設定し、Gateway ゲートウェイを再起動してプラグインを読み込みます。

## インストール

### オプションA: npmからインストール（推奨）

```bash
openclaw plugins install @openclaw/voice-call
```

インストール後にGateway ゲートウェイを再起動してください。

### オプションB: ローカルフォルダからインストール（開発用、コピーなし）

```bash
PLUGIN_SRC=./path/to/local/voice-call-plugin
openclaw plugins install "$PLUGIN_SRC"
cd "$PLUGIN_SRC" && pnpm install
```

インストール後にGateway ゲートウェイを再起動してください。

## 設定

`plugins.entries.voice-call.config` で設定を行います:

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

          telnyx: {
            apiKey: "...",
            connectionId: "...",
            // Telnyx Mission Control Portalから取得したwebhook公開鍵
            // （Base64文字列; TELNYX_PUBLIC_KEY環境変数でも設定可能）
            publicKey: "...",
          },

          plivo: {
            authId: "MAxxxxxxxxxxxxxxxxxxxx",
            authToken: "...",
          },

          // Webhookサーバー
          serve: {
            port: 3334,
            path: "/voice/webhook",
          },

          // Webhookセキュリティ（トンネル/プロキシ使用時に推奨）
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
            trustedProxyIPs: ["100.64.0.1"],
          },

          // 公開設定（いずれか1つを選択）
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

- Twilio/Telnyxには **公開到達可能な** webhook URLが必要です。
- Plivoには **公開到達可能な** webhook URLが必要です。
- `mock` はローカル開発用プロバイダーです（ネットワーク通信なし）。
- Telnyxでは `telnyx.publicKey`（または `TELNYX_PUBLIC_KEY`）が必要です。`skipSignatureVerification` が true の場合を除きます。
- `skipSignatureVerification` はローカルテスト専用です。
- ngrok無料プランを使用する場合は、`publicUrl` にngrokの正確なURLを設定してください。署名検証は常に適用されます。
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` は、`tunnel.provider="ngrok"` かつ `serve.bind` がloopbackの場合（ngrokローカルエージェント）に限り、無効な署名のTwilio webhookを許可します。ローカル開発専用です。
- ngrok無料プランのURLは変更されたりインタースティシャル動作が追加されたりする場合があります。`publicUrl` がずれるとTwilioの署名が失敗します。本番環境では安定したドメインまたはTailscale funnelを推奨します。
- ストリーミングセキュリティのデフォルト:
  - `streaming.preStartTimeoutMs` は、有効な `start` フレームを送信しないソケットを閉じます。
  - `streaming.maxPendingConnections` は、未認証のpre-startソケットの合計数を制限します。
  - `streaming.maxPendingConnectionsPerIp` は、送信元IPごとの未認証pre-startソケット数を制限します。
  - `streaming.maxConnections` は、オープン中のメディアストリームソケットの合計数（pending + active）を制限します。

## 失効した通話のリーパー

`staleCallReaperSeconds` を使用して、最終的なwebhookを受信しない通話（例: 完了しないnotifyモードの通話）を終了させます。デフォルトは `0`（無効）です。

推奨範囲:

- **本番環境:** notifyスタイルのフローには `120`〜`300` 秒。
- この値は **`maxDurationSeconds` より大きく** 設定し、通常の通話が完了できるようにします。`maxDurationSeconds + 30〜60` 秒が適切な開始点です。

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

## Webhookセキュリティ

プロキシやトンネルがGateway ゲートウェイの前段にある場合、プラグインは署名検証のために公開URLを再構築します。これらのオプションは、どの転送ヘッダーを信頼するかを制御します。

`webhookSecurity.allowedHosts` は転送ヘッダーからのホストを許可リストに登録します。

`webhookSecurity.trustForwardingHeaders` は許可リストなしで転送ヘッダーを信頼します。

`webhookSecurity.trustedProxyIPs` は、リクエストのリモートIPがリストに一致する場合にのみ転送ヘッダーを信頼します。

TwilioとPlivoではwebhookリプレイ保護が有効です。リプレイされた有効なwebhookリクエストは応答されますが、副作用はスキップされます。

Twilioの会話ターンには `<Gather>` コールバックにターンごとのトークンが含まれるため、古い/リプレイされた音声コールバックは新しいpending transcriptターンを満たすことができません。

未認証のwebhookリクエストは、プロバイダーの必須署名ヘッダーが欠落している場合、ボディの読み取り前に拒否されます。

voice-call webhookは共有のpre-authボディプロファイル（64 KB / 5秒）と、署名検証前のIPごとのin-flight上限を使用します。

安定した公開ホストを使用する例:

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

## 通話用TTS

Voice Callは通話中のストリーミング音声にコアの `messages.tts` 設定を使用します。プラグイン設定内で **同じ形式** で上書きでき、`messages.tts` とディープマージされます。

```json5
{
  tts: {
    provider: "elevenlabs",
    providers: {
      elevenlabs: {
        voiceId: "pMsXgVXv3BLzUgSXRplE",
        modelId: "eleven_multilingual_v2",
      },
    },
  },
}
```

注意事項:

- プラグイン設定内のレガシー `tts.<provider>` キー（`openai`、`elevenlabs`、`microsoft`、`edge`）は、ロード時に `tts.providers.<provider>` へ自動移行されます。コミットする設定では `providers` 形式を推奨します。
- **Microsoft speechは音声通話では無視されます**（テレフォニー音声にはPCMが必要ですが、現在のMicrosoftトランスポートはテレフォニーPCM出力を公開していません）。
- Twilioメディアストリーミングが有効な場合はコアTTSが使用されます。それ以外の場合、通話はプロバイダーのネイティブボイスにフォールバックします。
- Twilioメディアストリームがすでにアクティブな場合、Voice CallはTwiML `<Say>` にフォールバックしません。その状態でテレフォニーTTSが利用できない場合、2つの再生パスを混在させるのではなく、再生リクエストが失敗します。
- テレフォニーTTSがセカンダリプロバイダーにフォールバックした場合、Voice Callはデバッグ用にプロバイダーチェーン（`from`、`to`、`attempts`）を含む警告をログに記録します。

### その他の例

コアTTSのみを使用（上書きなし）:

```json5
{
  messages: {
    tts: {
      provider: "openai",
      providers: {
        openai: { voice: "alloy" },
      },
    },
  },
}
```

通話のみElevenLabsに上書き（他の箇所はコアのデフォルトを維持）:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            provider: "elevenlabs",
            providers: {
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
  },
}
```

通話用のOpenAIモデルのみを上書き（ディープマージの例）:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            providers: {
              openai: {
                model: "gpt-4o-mini-tts",
                voice: "marin",
              },
            },
          },
        },
      },
    },
  },
}
```

## 着信通話

インバウンドポリシーのデフォルトは `disabled` です。着信通話を有効にするには、以下を設定します:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

`inboundPolicy: "allowlist"` は低保証の発信者IDスクリーニングです。プラグインはプロバイダーが提供する `From` の値を正規化し、`allowFrom` と比較します。webhook検証はプロバイダーの配信とペイロードの整合性を認証しますが、PSTN/VoIPの発信者番号の所有権は証明しません。`allowFrom` は発信者IDフィルタリングとして扱い、強力な発信者身元確認としては扱わないでください。

自動応答はエージェントシステムを使用します。以下で調整できます:

- `responseModel`
- `responseSystemPrompt`
- `responseTimeoutMs`

### 音声出力コントラクト

自動応答の場合、Voice Callはシステムプロンプトに厳密な音声出力コントラクトを付加します:

- `{"spoken":"..."}`

Voice Callは音声テキストを防御的に抽出します:

- reasoning/errorコンテンツとしてマークされたペイロードを無視します。
- 直接JSON、フェンスドJSON、またはインラインの `"spoken"` キーを解析します。
- プレーンテキストにフォールバックし、計画/メタ的な導入段落を除去します。

これにより、音声再生は発信者向けテキストに集中し、計画テキストが音声に漏れることを防ぎます。

### 会話開始時の動作

発信 `conversation` 通話では、最初のメッセージの処理はライブ再生状態に連動します:

- 割り込みキューのクリアと自動応答は、初回の挨拶が実際に再生中の間のみ抑制されます。
- 初回再生が失敗した場合、通話は `listening` 状態に戻り、初回メッセージはリトライ用にキューに残ります。
- Twilioストリーミングの初回再生は、ストリーム接続時に追加の遅延なしで開始されます。

### Twilioストリーム切断の猶予期間

Twilioメディアストリームが切断された場合、Voice Callは通話を自動終了する前に `2000ms` 待機します:

- その期間内にストリームが再接続された場合、自動終了はキャンセルされます。
- 猶予期間後にストリームが再登録されない場合、通話がスタックしたまま残ることを防ぐために通話を終了します。

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall start --to "+15555550123"   # callのエイリアス
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall speak --call-id <id> --message "One moment"
openclaw voicecall end --call-id <id>
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw voicecall latency                     # ログからターンレイテンシを集計
openclaw voicecall expose --mode funnel
```

`latency` はデフォルトのvoice-callストレージパスから `calls.jsonl` を読み取ります。`--file <path>` で別のログファイルを指定し、`--last <n>` で分析対象を直近N件に制限できます（デフォルト200）。出力にはターンレイテンシとlisten-wait時間のp50/p90/p99が含まれます。

## エージェントツール

ツール名: `voice_call`

アクション:

- `initiate_call`（message, to?, mode?）
- `continue_call`（callId, message）
- `speak_to_user`（callId, message）
- `end_call`（callId）
- `get_status`（callId）

このリポジトリには対応するSkillドキュメントが `skills/voice-call/SKILL.md` にあります。

## Gateway ゲートウェイ RPC

- `voicecall.initiate`（`to?`, `message`, `mode?`）
- `voicecall.continue`（`callId`, `message`）
- `voicecall.speak`（`callId`, `message`）
- `voicecall.end`（`callId`）
- `voicecall.status`（`callId`）
