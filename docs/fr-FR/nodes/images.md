---
summary: "Règles gestion image et média pour envoi, passerelle et réponses agent"
read_when:
  - Modification pipeline média ou pièces jointes
title: "Support Image et Média"
---

# Support Image & Média

Le canal WhatsApp fonctionne via **Baileys Web**. Ce document capture règles gestion média actuelles pour envoi, passerelle et réponses agent.

## Objectifs

- Envoyer média avec légendes optionnelles via `openclaw message send --media`.
- Permettre réponses auto depuis inbox web d'inclure média aux côtés texte.
- Garder limites per-type saines et prévisibles.

## Surface CLI

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` optionnel ; légende peut être vide pour envois média-only.
  - `--dry-run` imprime payload résolu ; `--json` émet `{ channel, to, messageId, mediaUrl, caption }`.

## Comportement Canal WhatsApp Web

- Input : chemin fichier local **ou** URL HTTP(S).
- Flux : charger dans Buffer, détecter type média et construire payload correct :
  - **Images :** resize & recompress vers JPEG (côté max 2048px) ciblant `agents.defaults.mediaMaxMb` (défaut 5 MB), cappé à 6 MB.
  - **Audio/Voice/Video :** pass-through jusqu'à 16 MB ; audio envoyé comme note voix (`ptt: true`).
  - **Documents :** tout le reste, jusqu'à 100 MB, avec filename préservé quand disponible.
- Lecture style GIF WhatsApp : envoyer MP4 avec `gifPlayback: true` (CLI : `--gif-playback`) donc clients mobiles bouclent inline.
- Détection MIME préfère magic bytes, puis headers, puis extension fichier.
- Légende vient de `--message` ou `reply.text` ; légende vide est autorisée.

## Pipeline Auto-Reply

- `getReplyFromConfig` retourne `{ text?, mediaUrl?, mediaUrls? }`.
- Quand média présent, sender web résout chemins locaux ou URLs utilisant même pipeline que `openclaw message send`.
- Entrées média multiples envoyées séquentiellement si fournies.

## Média Entrant vers Commandes (Pi)

- Quand messages web entrants incluent média, OpenClaw télécharge vers fichier temp et expose variables templating :
  - `{{MediaUrl}}` pseudo-URL pour média entrant.
  - `{{MediaPath}}` chemin temp local écrit avant exécution commande.
- Quand sandbox Docker per-session activé, média entrant copié dans workspace sandbox et `MediaPath`/`MediaUrl` sont réécrits vers chemin relatif comme `media/inbound/<filename>`.
- Compréhension média (si configuré via `tools.media.*`) s'exécute avant templating et peut insérer blocs `[Image]`, `[Audio]` et `[Video]` dans `Body`.

## Limites & Erreurs

**Caps envoi outbound (WhatsApp web send)**

- Images : cap ~6 MB après recompression.
- Audio/voice/video : cap 16 MB ; documents : cap 100 MB.
- Média oversize ou illisible → erreur claire dans logs et reply sautée.

Voir aussi :

- [Compréhension Média](/fr-FR/nodes/media-understanding)
- [Envoi Message](/fr-FR/cli/message)
- [Canaux](/fr-FR/channels/index)
