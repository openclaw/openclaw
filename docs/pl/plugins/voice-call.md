---
summary: "Wtyczka Voice Call: połączenia wychodzące i przychodzące przez Twilio/Telnyx/Plivo (instalacja wtyczki + konfiguracja + CLI)"
read_when:
  - Chcesz wykonać wychodzące połączenie głosowe z OpenClaw
  - Konfigurujesz lub rozwijasz wtyczkę voice-call
title: "Wtyczka Voice Call"
---

# Voice Call (wtyczka)

Połączenia głosowe dla OpenClaw realizowane przez wtyczkę. Obsługuje powiadomienia wychodzące oraz
wieloturowe rozmowy z politykami połączeń przychodzących.

Aktualni dostawcy:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML transfer + GetInput speech)
- `mock` (dev/bez sieci)

Szybki model mentalny:

- Zainstaluj wtyczkę
- Zrestartuj Gateway
- Skonfiguruj w sekcji `plugins.entries.voice-call.config`
- Użyj `openclaw voicecall ...` lub narzędzia `voice_call`

## Gdzie działa (lokalnie vs zdalnie)

Wtyczka Voice Call działa **wewnątrz procesu Gateway**.

Jeśli używasz zdalnego Gateway, zainstaluj/skonfiguruj wtyczkę na **maszynie uruchamiającej Gateway**, a następnie zrestartuj Gateway, aby ją załadować.

## Instalacja

### Opcja A: instalacja z npm (zalecane)

```bash
openclaw plugins install @openclaw/voice-call
```

Następnie zrestartuj Gateway.

### Opcja B: instalacja z lokalnego folderu (dev, bez kopiowania)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

Następnie zrestartuj Gateway.

## Konfiguracja

Ustaw konfigurację w `plugins.entries.voice-call.config`:

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

Uwagi:

- Twilio/Telnyx wymagają **publicznie dostępnego** adresu URL webhooka.
- Plivo wymaga **publicznie dostępnego** adresu URL webhooka.
- `mock` to lokalny dostawca deweloperski (bez wywołań sieciowych).
- `skipSignatureVerification` jest przeznaczony wyłącznie do testów lokalnych.
- Jeśli używasz darmowego planu ngrok, ustaw `publicUrl` na dokładny adres URL ngrok; weryfikacja podpisów jest zawsze wymuszana.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` zezwala na webhooki Twilio z nieprawidłowymi podpisami **wyłącznie**, gdy `tunnel.provider="ngrok"` oraz `serve.bind` to loopback (lokalny agent ngrok). Używać tylko do lokalnego dev.
- Adresy URL darmowego planu ngrok mogą się zmieniać lub dodawać zachowanie pośrednie; jeśli `publicUrl` ulegnie rozjazdowi, podpisy Twilio będą zawodzić. W produkcji preferuj stabilną domenę lub funnel Tailscale.

## Bezpieczeństwo webhooków

Gdy przed Gateway znajduje się proxy lub tunel, wtyczka rekonstruuje
publiczny adres URL na potrzeby weryfikacji podpisu. Te opcje kontrolują,
które nagłówki przekazywane są uznawane za zaufane.

`webhookSecurity.allowedHosts` tworzy listę dozwolonych hostów z nagłówków przekazywania.

`webhookSecurity.trustForwardingHeaders` ufa nagłówkom przekazywania bez listy dozwolonych.

`webhookSecurity.trustedProxyIPs` ufa nagłówkom przekazywania tylko wtedy, gdy
zdalny adres IP żądania pasuje do listy.

Przykład ze stabilnym publicznym hostem:

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

## TTS dla połączeń

Voice Call używa podstawowej konfiguracji `messages.tts` (OpenAI lub ElevenLabs) do
strumieniowego generowania mowy w połączeniach. Możesz ją nadpisać w konfiguracji wtyczki,
zachowując **ten sam kształt** — następuje głębokie scalenie z `messages.tts`.

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

Uwagi:

- **Edge TTS jest ignorowany dla połączeń głosowych** (audio telefoniczne wymaga PCM; wyjście Edge jest zawodne).
- Podstawowy TTS jest używany, gdy włączone jest strumieniowanie mediów Twilio; w przeciwnym razie połączenia przechodzą na natywne głosy dostawcy.

### Więcej przykładów

Użyj tylko podstawowego TTS (bez nadpisywania):

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

Nadpisz na ElevenLabs tylko dla połączeń (zachowaj podstawową domyślną konfigurację gdzie indziej):

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

Nadpisz tylko model OpenAI dla połączeń (przykład głębokiego scalania):

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

## Połączenia przychodzące

Domyślna polityka połączeń przychodzących to `disabled`. Aby włączyć połączenia przychodzące, ustaw:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

Automatyczne odpowiedzi korzystają z systemu agentów. Dostosuj za pomocą:

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

## Narzędzie agenta

Nazwa narzędzia: `voice_call`

Akcje:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

To repozytorium zawiera pasujący dokument umiejętności pod adresem `skills/voice-call/SKILL.md`.

## RPC Gateway

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
