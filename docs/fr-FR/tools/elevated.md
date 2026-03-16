---
summary: "Mode exec elevated et directives /elevated"
read_when:
  - Ajustement défauts mode elevated, allowlists ou comportement commande slash
title: "Mode Elevated"
---

# Mode Elevated (directives /elevated)

## Ce qu'il fait

- `/elevated on` s'exécute sur l'hôte passerelle et garde les approbations exec (identique à `/elevated ask`).
- `/elevated full` s'exécute sur l'hôte passerelle **et** auto-approuve exec (saute les approbations exec).
- `/elevated ask` s'exécute sur l'hôte passerelle mais garde les approbations exec (identique à `/elevated on`).
- `on`/`ask` ne forcent **pas** `exec.security=full` ; la politique sécurité/ask configurée s'applique toujours.
- Change uniquement le comportement quand l'agent est **sandboxé** (sinon exec s'exécute déjà sur l'hôte).
- Formes directive : `/elevated on|off|ask|full`, `/elev on|off|ask|full`.
- Seuls `on|off|ask|full` sont acceptés ; tout autre chose retourne un hint et ne change pas l'état.

## Ce qu'il contrôle (et ce qu'il ne contrôle pas)

- **Gates disponibilité** : `tools.elevated` est la baseline globale. `agents.list[].tools.elevated` peut restreindre davantage elevated par agent (les deux doivent autoriser).
- **État par session** : `/elevated on|off|ask|full` définit le niveau elevated pour la clé session actuelle.
- **Directive inline** : `/elevated on|ask|full` à l'intérieur d'un message s'applique uniquement à ce message.
- **Groupes** : Dans les chats groupe, les directives elevated sont honorées uniquement quand l'agent est mentionné. Les messages commande uniquement qui contournent les exigences mention sont traités comme mentionnés.
- **Exécution hôte** : elevated force `exec` sur l'hôte passerelle ; `full` définit aussi `security=full`.
- **Approbations** : `full` saute les approbations exec ; `on`/`ask` les honorent quand les règles allowlist/ask le nécessitent.
- **Agents non sandboxés** : no-op pour l'emplacement ; affecte uniquement gating, logging et status.
- **La politique outil s'applique toujours** : si `exec` est refusé par la politique outil, elevated ne peut pas être utilisé.
- **Séparé de `/exec`** : `/exec` ajuste les défauts par session pour les expéditeurs autorisés et ne nécessite pas elevated.

## Ordre résolution

1. Directive inline sur le message (s'applique uniquement à ce message).
2. Override session (défini en envoyant un message directive uniquement).
3. Défaut global (`agents.defaults.elevatedDefault` dans config).

## Définir un défaut session

- Envoyez un message qui est **uniquement** la directive (espaces autorisés), par ex. `/elevated full`.
- La réponse confirmation est envoyée (`Mode elevated défini à full...` / `Mode elevated désactivé.`).
- Si l'accès elevated est désactivé ou l'expéditeur n'est pas sur l'allowlist approuvée, la directive répond avec une erreur actionnable et ne change pas l'état session.
- Envoyez `/elevated` (ou `/elevated:`) sans argument pour voir le niveau elevated actuel.

## Disponibilité + allowlists

- Gate fonctionnalité : `tools.elevated.enabled` (le défaut peut être off via config même si le code le supporte).
- Allowlist expéditeur : `tools.elevated.allowFrom` avec allowlists par fournisseur (par ex. `discord`, `whatsapp`).
- Gate par agent : `agents.list[].tools.elevated.enabled` (optionnel ; peut uniquement restreindre davantage).
- Allowlist par agent : `agents.list[].tools.elevated.allowFrom` (optionnel ; quand défini, l'expéditeur doit correspondre aux allowlists globale **et** par agent).
- Fallback Discord : si `tools.elevated.allowFrom.discord` est omis, la liste `channels.discord.allowFrom` est utilisée comme fallback (legacy : `channels.discord.dm.allowFrom`). Définissez `tools.elevated.allowFrom.discord` (même `[]`) pour remplacer. Les allowlists par agent n'utilisent **pas** le fallback.
- Tous les gates doivent passer ; sinon elevated est traité comme indisponible.

## Logging + status

- Les appels exec elevated sont loggés au niveau info.
- Le status session inclut le mode elevated (par ex. `elevated=ask`, `elevated=full`).
