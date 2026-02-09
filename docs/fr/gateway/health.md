---
summary: "Étapes de vérification de l’état pour la connectivité des canaux"
read_when:
  - Diagnostic de l’état du canal WhatsApp
title: "Contrôles de santé"
---

# Vérifications de l’état (CLI)

Guide court pour vérifier la connectivité des canaux sans tâtonner.

## Vérifications rapides

- `openclaw status` — résumé local : accessibilité/mode de la Gateway (passerelle), indication de mise à jour, ancienneté de l’authentification du canal lié, sessions + activité récente.
- `openclaw status --all` — diagnostic local complet (lecture seule, en couleur, sûr à coller pour le débogage).
- `openclaw status --deep` — sonde également la Gateway (passerelle) en cours d’exécution (sondes par canal lorsque prises en charge).
- `openclaw health --json` — demande à la Gateway (passerelle) en cours d’exécution un instantané complet de l’état (WS uniquement ; pas de socket Baileys directe).
- Envoyez `/status` comme message autonome dans WhatsApp/WebChat pour obtenir une réponse d’état sans invoquer l’agent.
- Journaux : tail `/tmp/openclaw/openclaw-*.log` et filtrez sur `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.

## Diagnostics approfondis

- Identifiants sur disque : `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (le mtime doit être récent).
- Stockage de session : `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (le chemin peut être remplacé dans la configuration). Le nombre et les destinataires récents sont exposés via `status`.
- Flux de reliaison : `openclaw channels logout && openclaw channels login --verbose` lorsque des codes d’état 409–515 ou `loggedOut` apparaissent dans les journaux. (Remarque : le flux de connexion par QR redémarre automatiquement une fois pour l’état 515 après l’appairage.)

## Quand quelque chose échoue

- `logged out` ou état 409–515 → reliez de nouveau avec `openclaw channels logout` puis `openclaw channels login`.
- Gateway (passerelle) injoignable → démarrez-la : `openclaw gateway --port 18789` (utilisez `--force` si le port est occupé).
- Aucun message entrant → confirmez que le téléphone lié est en ligne et que l’expéditeur est autorisé (`channels.whatsapp.allowFrom`) ; pour les discussions de groupe, assurez-vous que les règles de liste d’autorisation + de mention correspondent (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Commande « health » dédiée

`openclaw health --json` demande à la Gateway (passerelle) en cours d’exécution son instantané d’état (pas de sockets de canal directes depuis le CLI). Elle rapporte, lorsque disponibles, les identifiants liés/l’ancienneté de l’authentification, des résumés de sondes par canal, un résumé du stockage de sessions et une durée de sonde. Elle se termine avec un code non nul si la Gateway (passerelle) est injoignable ou si la sonde échoue/expire. Utilisez `--timeout <ms>` pour remplacer la valeur par défaut de 10 s.
