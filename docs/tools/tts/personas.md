---
summary: "Persona definitions, provider bindings, resolution order, and fallback policy"
title: "Text-to-speech personas"
read_when:
  - You want one stable spoken identity across providers
  - You need the persona and provider resolution order
  - You are choosing a persona fallback policy
---

## Personas

A **persona** is a stable spoken identity that can be applied deterministically
across providers. It can prefer one provider, define provider-neutral prompt
intent, and carry provider-specific bindings for voices, models, prompt
templates, seeds, and voice settings.

### Minimal persona

```json5
{
  tts: {
    auto: "always",
    persona: "narrator",
    personas: {
      narrator: {
        label: "Narrator",
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            speakerVoiceId: "EXAVITQu4vr4xnSDxMaL",
            modelId: "eleven_multilingual_v2",
          },
        },
      },
    },
  },
}
```

### Full persona (provider-specific shaping)

```json5
{
  tts: {
    auto: "always",
    persona: "alfred",
    personas: {
      alfred: {
        label: "Alfred",
        description: "Dry, warm British butler narrator.",
        provider: "google",
        fallbackPolicy: "preserve-persona",
        providers: {
          google: {
            model: "gemini-3.1-flash-tts-preview",
            speakerVoice: "Algieba",
            promptTemplate: "audio-profile-v1",
          },
          openai: { model: "gpt-4o-mini-tts", speakerVoice: "cedar" },
          elevenlabs: {
            speakerVoiceId: "voice_id",
            modelId: "eleven_multilingual_v2",
            seed: 42,
            voiceSettings: {
              stability: 0.65,
              similarityBoost: 0.8,
              style: 0.25,
              useSpeakerBoost: true,
              speed: 0.95,
            },
          },
        },
      },
    },
  },
}
```

### Persona resolution

The active persona is selected deterministically:

1. `/tts persona <id>` local preference, if set.
2. `tts.persona`, if set.
3. No persona.

Provider selection runs explicit-first:

1. Direct overrides (CLI, gateway, Talk, allowed TTS directives).
2. `/tts provider <id>` local preference.
3. Active persona's `provider`.
4. `tts.provider`.
5. Registry auto-select.

For each provider attempt, OpenClaw merges configs in this order:

1. `tts.providers.<id>`
2. `tts.personas.<persona>.providers.<id>`
3. Trusted request overrides
4. Allowed model-emitted TTS directive overrides

### Custom persona shaping

Provider-neutral `personas.<id>.prompt.*` config is retired. Doctor removes
those fields and points to the speech-provider seam. Put built-in provider
settings under `personas.<id>.providers.<provider>` (for example Google
`personaPrompt` or OpenAI `instructions`). For custom shaping, implement a
speech provider plugin with `prepareSynthesis(ctx)` and return adjusted text,
provider config, or overrides before `synthesize()` runs. This keeps expressive
prompt construction in provider code where request semantics are known.

### Fallback policy

`fallbackPolicy` controls behavior when a persona has **no binding** for the
attempted provider:

| Policy              | Behavior                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `preserve-persona`  | **Default.** Provider-neutral prompt fields stay available; the provider may use them or ignore them.                                            |
| `provider-defaults` | Persona is omitted from prompt preparation for that attempt; the provider uses its neutral defaults while fallback to other providers continues. |
| `fail`              | Skip that provider attempt with `reasonCode: "not_configured"` and `personaBinding: "missing"`. Fallback providers are still tried.              |

The whole TTS request only fails when **every** attempted provider is skipped
or fails.

Talk session provider selection is session-scoped. A Talk client should choose
provider ids, model ids, voice ids, and locales from `talk.catalog` and pass
them through the Talk session or handoff request. Opening a voice session should
not mutate `tts` or global Talk provider defaults.
