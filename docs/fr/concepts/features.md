---
summary: "Capacités d’OpenClaw à travers les canaux, le routage, les médias et l’UX."
read_when:
  - Vous voulez une liste complete de ce que prend en charge OpenClaw
title: "Fonctionnalites"
---

## Highlights

<Columns>
  <Card title="Channels" icon="message-square">
    WhatsApp, Telegram, Discord et iMessage avec une seule Gateway (passerelle).
  </Card>
  <Card title="Plugins" icon="plug">
    Ajoutez Mattermost et plus encore avec des extensions.
  </Card>
  <Card title="Routing" icon="route">
    Routage multi-agent avec des sessions isolees.
  </Card>
  <Card title="Media" icon="image">
    Images, audio et documents en entree et en sortie.
  </Card>
  <Card title="Apps and UI" icon="monitor">
    Interface de controle Web et application compagnon macOS.
  </Card>
  <Card title="Mobile nodes" icon="smartphone">
    Noeuds iOS et Android avec prise en charge de Canvas.
  </Card>
</Columns>

## Full list

- Integration WhatsApp via WhatsApp Web (Baileys)
- Prise en charge des bots Telegram (grammY)
- Prise en charge des bots Discord (channels.discord.js)
- Prise en charge des bots Mattermost (plugin)
- Integration iMessage via le CLI local imsg (macOS)
- Passerelle d’agents pour Pi en mode RPC avec streaming d’outils
- Streaming et decoupage en segments pour les reponses longues
- Routage multi-agent pour des sessions isolees par espace de travail ou expediteur
- Authentification par abonnement pour Anthropic et OpenAI via OAuth
- Sessions : les discussions directes sont regroupees dans `main` ; les groupes sont isoles
- Prise en charge des discussions de groupe avec activation basee sur les mentions
- Prise en charge des medias pour les images, l’audio et les documents
- Hook optionnel de transcription des messages vocaux
- WebChat et application de barre de menu macOS
- Noeud iOS avec appairage et surface Canvas
- Noeud Android avec appairage, Canvas, chat et camera

<Note>
Les chemins herites Claude, Codex, Gemini et Opencode ont ete supprimes. Pi est le seul
chemin d’agent de codage.
</Note>
