---
summary: "Plugin Voice Call : appels sortants + entrants via Twilio/Telnyx/Plivo (installation plugin + config + CLI)"
read_when:
  - Vous voulez passer un appel vocal sortant depuis OpenClaw
  - Vous configurez ou développez le plugin voice-call
title: "Plugin Voice Call"
---

# Voice Call (plugin)

Appels vocaux pour OpenClaw via un plugin. Supporte les notifications sortantes et
les conversations multi-tours avec politiques d'appels entrants.

Fournisseurs actuels :

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + transfert XML + parole GetInput)
- `mock` (dev/sans réseau)

Modèle mental rapide :

- Installer le plugin
- Redémarrer la Passerelle
- Configurer sous `plugins.entries.voice-call.config`
- Utiliser `openclaw voicecall ...` ou l'outil `voice_call`

## Où il s'exécute (local vs distant)

Le plugin Voice Call s'exécute **à l'intérieur du processus de Passerelle**.

Si vous utilisez une Passerelle distante, installez/configurez le plugin sur la **machine exécutant la Passerelle**, puis redémarrez la Passerelle pour le charger.

## Installation

### Option A : installer depuis npm (recommandé)

```bash
openclaw plugins install @openclaw/voice-call
```

Redémarrez la Passerelle ensuite.

### Option B : installer depuis un dossier local (dev, sans copie)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

Redémarrez la Passerelle ensuite.

## Configuration

Définissez la config sous `plugins.entries.voice-call.config` :

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio", // ou "telnyx" | "plivo" | "mock"
          fromNumber: "+15550001234",
          toNumber: "+15550005678",

          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "...",
          },

          telnyx: {
            apiKey: "...",
            connectionId: "...",
            // Clé publique webhook Telnyx depuis le portail Telnyx Mission Control
            // (Chaîne Base64 ; peut aussi être définie via TELNYX_PUBLIC_KEY).
            publicKey: "...",
          },

          plivo: {
            authId: "MAxxxxxxxxxxxxxxxxxxxx",
            authToken: "...",
          },

          // Serveur webhook
          serve: {
            port: 3334,
            path: "/voice/webhook",
          },

          // Sécurité webhook (recommandé pour tunnels/proxies)
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
            trustedProxyIPs: ["100.64.0.1"],
          },

          // Exposition publique (choisir un)
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

Notes :

- Twilio/Telnyx nécessitent une URL webhook **publiquement accessible**.
- Plivo nécessite une URL webhook **publiquement accessible**.
- `mock` est un fournisseur de dev local (pas d'appels réseau).
- Telnyx nécessite `telnyx.publicKey` (ou `TELNYX_PUBLIC_KEY`) sauf si `skipSignatureVerification` est true.
- `skipSignatureVerification` est pour les tests locaux uniquement.
- Si vous utilisez le tier gratuit ngrok, définissez `publicUrl` sur l'URL ngrok exacte ; la vérification de signature est toujours appliquée.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` permet les webhooks Twilio avec signatures invalides **uniquement** quand `tunnel.provider="ngrok"` et `serve.bind` est loopback (agent local ngrok). Utiliser pour le dev local uniquement.
- Les URLs du tier gratuit ngrok peuvent changer ou ajouter un comportement interstitiel ; si `publicUrl` dérive, les signatures Twilio échoueront. Pour la production, préférez un domaine stable ou Tailscale funnel.

## Sécurité webhook

Quand un proxy ou tunnel se trouve devant la Passerelle, le plugin reconstruit l'URL
publique pour la vérification de signature. Ces options contrôlent quels en-têtes transférés
sont fiables.

`webhookSecurity.allowedHosts` liste blanche les hôtes des en-têtes de transfert.

`webhookSecurity.trustForwardingHeaders` fait confiance aux en-têtes transférés sans liste blanche.

`webhookSecurity.trustedProxyIPs` fait confiance aux en-têtes transférés uniquement quand l'IP
distante de la requête correspond à la liste.

Exemple avec un hôte public stable :

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

Voice Call utilise la configuration principale `messages.tts` (OpenAI ou ElevenLabs) pour
la parole en streaming sur les appels. Vous pouvez la remplacer sous la config du plugin avec la
**même forme** — elle fusionne en profondeur avec `messages.tts`.

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

Notes :

- **Edge TTS est ignoré pour les appels vocaux** (l'audio de téléphonie nécessite PCM ; la sortie Edge est peu fiable).
- Le TTS principal est utilisé quand le streaming média Twilio est activé ; sinon les appels replient vers les voix natives du fournisseur.

### Plus d'exemples

Utiliser uniquement le TTS principal (pas de remplacement) :

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

Remplacer par ElevenLabs juste pour les appels (garder le défaut principal ailleurs) :

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

Remplacer uniquement le modèle OpenAI pour les appels (exemple de fusion profonde) :

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

La politique d'appels entrants est par défaut `disabled`. Pour activer les appels entrants, définissez :

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Bonjour ! Comment puis-je vous aider ?",
}
```

Les réponses automatiques utilisent le système d'agent. Ajustez avec :

- `responseModel`
- `responseSystemPrompt`
- `responseTimeoutMs`

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Bonjour depuis OpenClaw"
openclaw voicecall continue --call-id <id> --message "Des questions ?"
openclaw voicecall speak --call-id <id> --message "Un instant"
openclaw voicecall end --call-id <id>
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw voicecall expose --mode funnel
```

## Outil d'agent

Nom d'outil : `voice_call`

Actions :

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

Ce dépôt livre un document de compétence correspondant à `skills/voice-call/SKILL.md`.

## RPC de passerelle

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
