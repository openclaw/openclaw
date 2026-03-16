---
summary: "Référence CLI pour `openclaw security` (audit et correction de pièges de sécurité courants)"
read_when:
  - Vous voulez exécuter un audit de sécurité rapide sur config/état
  - Vous voulez appliquer des suggestions de "correctif" sûres (chmod, resserrer les défauts)
title: "security"
---

# `openclaw security`

Outils de sécurité (audit + correctifs optionnels).

Connexe :

- Guide de sécurité : [Sécurité](/fr-FR/gateway/security)

## Audit

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

L'audit avertit quand plusieurs expéditeurs DM partagent la session principale et recommande **le mode DM sécurisé** : `session.dmScope="per-channel-peer"` (ou `per-account-channel-peer` pour les canaux multi-comptes) pour les boîtes de réception partagées.
Il avertit aussi quand des petits modèles (`<=300B`) sont utilisés sans sandbox et avec les outils web/browser activés.
Pour l'ingress webhook, il avertit quand `hooks.defaultSessionKey` n'est pas défini, quand les remplacements de requête `sessionKey` sont activés, et quand les remplacements sont activés sans `hooks.allowedSessionKeyPrefixes`.
Il avertit aussi quand les paramètres Docker sandbox sont configurés alors que le mode sandbox est désactivé, quand `gateway.nodes.denyCommands` utilise des entrées de type motif/inconnues inefficaces, quand le `tools.profile="minimal"` global est remplacé par des profils d'outils d'agent, et quand des outils de plugin d'extension installés peuvent être accessibles sous une politique d'outil permissive.
