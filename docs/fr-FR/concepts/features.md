---
summary: "Capacités d'OpenClaw à travers les canaux, le routage, les médias et l'UX."
read_when:
  - Vous voulez une liste complète de ce qu'OpenClaw prend en charge
title: "Fonctionnalités"
---

## Points forts

<Columns>
  <Card title="Canaux" icon="message-square">
    WhatsApp, Telegram, Discord et iMessage avec une seule Passerelle.
  </Card>
  <Card title="Plugins" icon="plug">
    Ajoutez Mattermost et plus avec des extensions.
  </Card>
  <Card title="Routage" icon="route">
    Routage multi-agents avec sessions isolées.
  </Card>
  <Card title="Médias" icon="image">
    Images, audio et documents en entrée et sortie.
  </Card>
  <Card title="Apps et Interface" icon="monitor">
    Interface de contrôle web et app compagnon macOS.
  </Card>
  <Card title="Nœuds mobiles" icon="smartphone">
    Nœuds iOS et Android avec support Canvas.
  </Card>
</Columns>

## Liste complète

- Intégration WhatsApp via WhatsApp Web (Baileys)
- Support de bot Telegram (grammY)
- Support de bot Discord (channels.discord.js)
- Support de bot Mattermost (plugin)
- Intégration iMessage via CLI imsg local (macOS)
- Pont d'agent pour Pi en mode RPC avec streaming d'outils
- Streaming et découpage pour les réponses longues
- Routage multi-agents pour sessions isolées par espace de travail ou expéditeur
- Authentification par abonnement pour Anthropic et OpenAI via OAuth
- Sessions : les chats directs fusionnent dans un `main` partagé ; les groupes sont isolés
- Support de chat de groupe avec activation basée sur les mentions
- Support de médias pour images, audio et documents
- Hook optionnel de transcription de notes vocales
- WebChat et app barre de menu macOS
- Nœud iOS avec appairage et surface Canvas
- Nœud Android avec appairage, Canvas, chat et caméra

<Note>
Les chemins hérités Claude, Codex, Gemini et Opencode ont été supprimés. Pi est le seul
chemin d'agent de codage.
</Note>
