---
summary: "Plugin d’appel vocal : appels sortants + entrants via Twilio/Telnyx/Plivo (installation du plugin + configuration + CLI)"
read_when:
  - Vous souhaitez passer un appel vocal sortant depuis OpenClaw
  - Vous configurez ou developpez le plugin voice-call
title: "Plugin d’appel vocal"
---

# Appel vocal (plugin)

Appels vocaux pour OpenClaw via un plugin. Prend en charge les notifications sortantes et
les conversations multi-tours avec des politiques entrantes.

Fournisseurs actuels :

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + transfert XML + GetInput speech)
- `mock` (dev/pas de reseau)

Modele mental rapide :

- Installer le plugin
- Redemarrer la Gateway (passerelle)
- Configurer sous `plugins.entries.voice-call.config`
- Utiliser `openclaw voicecall ...` ou l’outil `voice_call`

## Ou cela s’execute (local vs distant)

Le plugin Appel vocal s’execute **a l’interieur du processus de la Gateway (passerelle)**.

Si vous utilisez une Gateway (passerelle) distante, installez/configurez le plugin sur la **machine qui execute la Gateway (passerelle)**, puis redemarrez la Gateway (passerelle) pour le charger.

## Installation

### Option A : installer depuis npm (recommande)

```bash
openclaw plugins install @openclaw/voice-call
```

Redemarrez ensuite la Gateway (passerelle).

### Option B : installer depuis un dossier local (dev, sans copie)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

Redemarrez ensuite la Gateway (passerelle).

## Configuration

Definissez la configuration sous `plugins.entries.voice-call.config` :

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

Notes :

- Twilio/Telnyx necessitent une URL de webhook **accessible publiquement**.
- Plivo necessite une URL de webhook **accessible publiquement**.
- `mock` est un fournisseur local de dev (aucun appel reseau).
- `skipSignatureVerification` est reserve aux tests locaux uniquement.
- Si vous utilisez l’offre gratuite ngrok, definissez `publicUrl` sur l’URL ngrok exacte ; la verification de signature est toujours appliquee.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` autorise les webhooks Twilio avec des signatures invalides **uniquement** lorsque `tunnel.provider="ngrok"` et que `serve.bind` est en loopback (agent local ngrok). A utiliser uniquement pour le dev local.
- Les URL de l’offre gratuite ngrok peuvent changer ou ajouter un comportement interstitiel ; si `publicUrl` diverge, les signatures Twilio echoueront. En production, preferez un domaine stable ou un funnel Tailscale.

## Securite des webhooks

Lorsqu’un proxy ou un tunnel se trouve devant la Gateway (passerelle), le plugin reconstruit
l’URL publique pour la verification de signature. Ces options controlent quels en-tetes
transmis sont approuves.

`webhookSecurity.allowedHosts` met sur liste d’autorisation les hôtes provenant des en-tetes de transfert.

`webhookSecurity.trustForwardingHeaders` fait confiance aux en-tetes de transfert sans liste d’autorisation.

`webhookSecurity.trustedProxyIPs` ne fait confiance aux en-tetes de transfert que lorsque l’IP distante de la requete correspond a la liste.

Exemple avec un hôte public stable :

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

## TTS pour les appels

L’Appel vocal utilise la configuration TTS principale `messages.tts` (OpenAI ou ElevenLabs) pour
la synthese vocale en streaming pendant les appels. Vous pouvez la remplacer sous la configuration du plugin avec la **meme structure** — elle est fusionnee en profondeur avec `messages.tts`.

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

Notes :

- **Edge TTS est ignore pour les appels vocaux** (l’audio de telephonie necessite du PCM ; la sortie Edge est peu fiable).
- Le TTS principal est utilise lorsque le streaming media Twilio est active ; sinon, les appels basculent vers les voix natives du fournisseur.

### Plus d’exemples

Utiliser uniquement le TTS principal (sans surcharge) :

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

Surcharger vers ElevenLabs uniquement pour les appels (conserver le defaut principal ailleurs) :

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

Surcharger uniquement le modele OpenAI pour les appels (exemple de fusion profonde) :

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

## Appels entrants

La politique entrante par defaut est `disabled`. Pour activer les appels entrants, definissez :

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

Les reponses automatiques utilisent le systeme d’agents. Ajustez avec :

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

## Outil d’agent

Nom de l’outil : `voice_call`

Actions :

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

Ce depot fournit une documentation de skill correspondante a `skills/voice-call/SKILL.md`.

## RPC de la Gateway (passerelle)

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
