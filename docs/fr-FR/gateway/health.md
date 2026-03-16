---
summary: "Étapes de vérification de santé pour la connectivité des canaux"
read_when:
  - Diagnostic de la santé du canal WhatsApp
title: "Vérifications de santé"
---

# Vérifications de santé (CLI)

Guide rapide pour vérifier la connectivité des canaux sans deviner.

## Vérifications rapides

- `openclaw status` — résumé local : accessibilité/mode de la passerelle, indication de mise à jour, âge de l'auth canal lié, sessions + activité récente.
- `openclaw status --all` — diagnostic local complet (lecture seule, couleur, sûr à coller pour débogage).
- `openclaw status --deep` — sonde également la Passerelle en cours d'exécution (sondes par canal lorsque supporté).
- `openclaw health --json` — demande à la Passerelle en cours d'exécution un instantané de santé complet (WS uniquement ; pas de socket Baileys direct).
- Envoyez `/status` comme message autonome dans WhatsApp/WebChat pour obtenir une réponse de statut sans invoquer l'agent.
- Journaux : suivez `/tmp/openclaw/openclaw-*.log` et filtrez pour `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.

## Diagnostics approfondis

- Credentials sur disque : `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime devrait être récent).
- Magasin de sessions : `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (le chemin peut être remplacé dans la config). Le nombre et les destinataires récents sont affichés via `status`.
- Flux de reconnexion : `openclaw channels logout && openclaw channels login --verbose` lorsque les codes de statut 409–515 ou `loggedOut` apparaissent dans les journaux. (Note : le flux de connexion QR redémarre automatiquement une fois pour le statut 515 après l'appairage.)

## Quand quelque chose échoue

- `logged out` ou statut 409–515 → reconnectez avec `openclaw channels logout` puis `openclaw channels login`.
- Passerelle inaccessible → démarrez-la : `openclaw gateway --port 18789` (utilisez `--force` si le port est occupé).
- Pas de messages entrants → confirmez que le téléphone lié est en ligne et que l'expéditeur est autorisé (`channels.whatsapp.allowFrom`) ; pour les chats de groupe, assurez-vous que la liste autorisée + les règles de mention correspondent (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Commande "health" dédiée

`openclaw health --json` demande à la Passerelle en cours d'exécution son instantané de santé (pas de sockets de canal directs depuis le CLI). Elle rapporte les creds/âge auth liés lorsque disponibles, les résumés de sondes par canal, le résumé du magasin de sessions, et une durée de sonde. Elle sort avec un code non-zéro si la Passerelle est inaccessible ou si la sonde échoue/expire. Utilisez `--timeout <ms>` pour remplacer la valeur par défaut de 10s.
