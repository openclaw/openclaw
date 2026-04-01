# Architect Memory

## Meta-patterns & pièges fréquents

- Les bootstrap files (AGENTS.md, TOOLS.md) sont tronqués à 20k chars — tout ajout doit vérifier la marge
- Mem0 autoCapture est activé — les agents dupliquent les données si SOUL.md ne l'interdit pas explicitement
- Les patches dist sont fragiles : après npm update, les noms de fichiers changent (chercher `password-store` pour Chrome, `runHeartbeatOnce` pour gateway)
- Le delivery pipeline a 12 gates — un cron qui ne délivre pas peut être bloqué à n'importe laquelle
- WhatsApp toolNotifications désactivé intentionnellement — ne pas réactiver
- Les 7 fichiers source patchés (§13) ne doivent JAMAIS être touchés par le code-fixer

## Zones fragiles du codebase

- `dispatch-from-config.ts` : point névralgique du routing messages, touché par 2 patches
- `chrome.ts` : patch CDP obligatoire, sinon 403 WebSocket
- `timer.ts` / `server-cron.ts` : orchestration crons, patché pour agentId forwarding
- Bootstrap files : proches de la limite 16k pour workspace/AGENTS.md (14.3k)

## Décisions de design récurrentes

- Self-hosted > SaaS (sauf si complexité ops disproportionnée)
- Python scripts pour skills (pas de nouveau service Node)
- Fichiers JSON + atomic write > base de données pour données simples

## Mises à jour ARCHITECTURE.md en attente

(vide — à remplir au fil des revues)
