---
summary: "Comment notes audio/voix entrantes sont téléchargées, transcrites et injectées dans réponses"
read_when:
  - Changement transcription audio ou gestion média
title: "Audio et Notes Voix"
---

# Audio / Notes Voix

## Ce qui fonctionne

- **Compréhension média (audio)** : Si compréhension audio est activée (ou auto-détectée), OpenClaw :
  1. Localise première pièce jointe audio (chemin local ou URL) et la télécharge si nécessaire.
  2. Enforce `maxBytes` avant envoi à chaque entrée modèle.
  3. Exécute première entrée modèle éligible par ordre (provider ou CLI).
  4. Si échec ou saute (taille/timeout), essaie entrée suivante.
  5. Sur succès, remplace `Body` avec bloc `[Audio]` et définit `{{Transcript}}`.
- **Parsing commande** : Quand transcription réussit, `CommandBody`/`RawBody` sont définis au transcript donc commandes slash fonctionnent toujours.
- **Logging verbeux** : Dans `--verbose`, nous loggons quand transcription s'exécute et quand elle remplace body.

## Auto-détection (défaut)

Si vous **ne configurez pas modèles** et `tools.media.audio.enabled` n'est **pas** défini à `false`, OpenClaw auto-détecte dans cet ordre et s'arrête à première option fonctionnelle :

1. **CLIs Locaux** (si installés)
   - `sherpa-onnx-offline` (nécessite `SHERPA_ONNX_MODEL_DIR` avec encoder/decoder/joiner/tokens)
   - `whisper-cli` (depuis `whisper-cpp` ; utilise `WHISPER_CPP_MODEL` ou modèle tiny bundled)
   - `whisper` (Python CLI ; télécharge modèles automatiquement)
2. **Gemini CLI** (`gemini`) utilisant `read_many_files`
3. **Clés Provider** (OpenAI → Groq → Deepgram → Google)

Pour désactiver auto-détection, définissez `tools.media.audio.enabled: false`. Pour personnaliser, définissez `tools.media.audio.models`.

## Exemples Config

### Provider + Fallback CLI (OpenAI + Whisper CLI)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
            timeoutSeconds: 45,
          },
        ],
      },
    },
  },
}
```

Voir aussi :

- [Compréhension Média](/fr-FR/nodes/media-understanding)
- [Nœuds](/fr-FR/nodes/index)
- [Configuration](/fr-FR/gateway/configuration)
