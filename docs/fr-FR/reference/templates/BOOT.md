---
title: "Template BOOT.md"
summary: "Template workspace pour BOOT.md"
read_when:
  - Ajout checklist BOOT.md
---

# BOOT.md

Ajoutez instructions courtes et explicites pour ce qu'OpenClaw devrait faire au démarrage (activez `hooks.internal.enabled`).

Si tâche envoie message, utilisez tool message puis répondez avec NO_REPLY.

## Exemple

```markdown
# BOOT.md

Au démarrage :

1. Vérifier calendrier aujourd'hui
2. Vérifier emails non lus
3. Si meetings dans 30 min, envoyer reminder
4. Répondre NO_REPLY
```

## Configuration

Pour activer exécution BOOT.md :

```json5
{
  hooks: {
    internal: {
      enabled: true,
    },
  },
}
```

## Notes

- BOOT.md s'exécute **une fois** au démarrage passerelle
- Utilisez `NO_REPLY` pour éviter envoyer réponse visible
- Bon pour tasks housekeeping, checks santé, reminders
- Gardez instructions courtes - temps démarrage affecte latence

Voir aussi :

- [Hooks](/fr-FR/automation/hooks)
- [Workspace](/fr-FR/concepts/agent-workspace)
- [Bootstrap](/fr-FR/start/bootstrapping)
