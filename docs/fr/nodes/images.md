---
summary: "Regles de gestion des images et des medias pour l’envoi, la Gateway (passerelle) et les reponses de l’agent"
read_when:
  - Modification du pipeline media ou des pieces jointes
title: "Prise en charge des images et des medias"
---

# Prise en charge des images et des medias — 2025-12-05

Le canal WhatsApp fonctionne via **Baileys Web**. Ce document presente les regles actuelles de gestion des medias pour les envois, la Gateway (passerelle) et les reponses de l’agent.

## Objectifs

- Envoyer des medias avec des legendes facultatives via `openclaw message send --media`.
- Permettre aux reponses automatiques depuis la boite de reception web d’inclure des medias en plus du texte.
- Maintenir des limites par type raisonnables et previsibles.

## Surface CLI

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` facultatif ; la legende peut etre vide pour des envois uniquement media.
  - `--dry-run` affiche la charge utile resolue ; `--json` emet `{ channel, to, messageId, mediaUrl, caption }`.

## Comportement du canal WhatsApp Web

- Entree : chemin de fichier local **ou** URL HTTP(S).
- Flux : chargement dans un Buffer, detection du type de media et construction de la charge utile correcte :
  - **Images :** redimensionnement et recompression en JPEG (cote max 2048 px) en visant `agents.defaults.mediaMaxMb` (par defaut 5 Mo), avec un plafond a 6 Mo.
  - **Audio/Voix/Video :** passage direct jusqu’a 16 Mo ; l’audio est envoye comme note vocale (`ptt: true`).
  - **Documents :** tout le reste, jusqu’a 100 Mo, avec conservation du nom de fichier lorsque disponible.
- Lecture de type GIF WhatsApp : envoyer un MP4 avec `gifPlayback: true` (CLI : `--gif-playback`) afin que les clients mobiles bouclent en lecture integree.
- La detection MIME privilegie les magic bytes, puis les en-tetes, puis l’extension de fichier.
- La legende provient de `--message` ou `reply.text` ; une legende vide est autorisee.
- Journalisation : en mode non verbeux, affiche `↩️`/`✅` ; en mode verbeux, inclut la taille et le chemin/la source URL.

## Pipeline de reponse automatique

- `getReplyFromConfig` renvoie `{ text?, mediaUrl?, mediaUrls? }`.
- Lorsqu’un media est present, l’emetteur web resout les chemins locaux ou les URL en utilisant le meme pipeline que `openclaw message send`.
- Plusieurs entrees media sont envoyees sequentiellement si elles sont fournies.

## Medias entrants vers les commandes (Pi)

- Lorsque des messages web entrants incluent des medias, OpenClaw telecharge vers un fichier temporaire et expose des variables de templating :
  - `{{MediaUrl}}` pseudo-URL pour le media entrant.
  - `{{MediaPath}}` chemin temporaire local ecrit avant l’execution de la commande.
- Lorsqu’un sandbox Docker par session est active, les medias entrants sont copies dans l’espace de travail du sandbox et `MediaPath`/`MediaUrl` sont reecrits vers un chemin relatif comme `media/inbound/<filename>`.
- La comprehension des medias (si configuree via `tools.media.*` ou partagee `tools.media.models`) s’execute avant le templating et peut inserer des blocs `[Image]`, `[Audio]` et `[Video]` dans `Body`.
  - L’audio definit `{{Transcript}}` et utilise la transcription pour l’analyse des commandes afin que les commandes slash continuent de fonctionner.
  - Les descriptions de video et d’image conservent tout texte de legende pour l’analyse des commandes.
- Par defaut, seule la premiere piece jointe image/audio/video correspondante est traitee ; definissez `tools.media.<cap>.attachments` pour traiter plusieurs pieces jointes.

## Limites et erreurs

**Plafonds d’envoi sortant (envoi web WhatsApp)**

- Images : plafond d’environ 6 Mo apres recompression.
- Audio/voix/video : plafond de 16 Mo ; documents : plafond de 100 Mo.
- Media trop volumineux ou illisible → erreur explicite dans les journaux et la reponse est ignoree.

**Plafonds de comprehension des medias (transcription/description)**

- Image par defaut : 10 Mo (`tools.media.image.maxBytes`).
- Audio par defaut : 20 Mo (`tools.media.audio.maxBytes`).
- Video par defaut : 50 Mo (`tools.media.video.maxBytes`).
- Les medias trop volumineux ignorent la comprehension, mais les reponses sont tout de meme envoyees avec le corps d’origine.

## Notes pour les tests

- Couvrir les flux d’envoi et de reponse pour les cas image/audio/document.
- Valider la recompression des images (borne de taille) et l’indicateur de note vocale pour l’audio.
- S’assurer que les reponses multi-medias se deploient en envois sequentiels.
