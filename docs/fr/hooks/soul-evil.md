---
summary: "Hook SOUL Evil (remplacer SOUL.md par SOUL_EVIL.md)"
read_when:
  - Vous souhaitez activer ou ajuster le hook SOUL Evil
  - Vous souhaitez une fenêtre de purge ou un échange de persona aléatoire
title: "Hook SOUL Evil"
---

# Hook SOUL Evil

Le hook SOUL Evil remplace le contenu **injecté** `SOUL.md` par `SOUL_EVIL.md` pendant
une fenêtre de purge ou de manière aléatoire. Il **ne** modifie **pas** les fichiers sur le disque.

## Fonctionnement

Lorsque `agent:bootstrap` s’exécute, le hook peut remplacer le contenu `SOUL.md` en mémoire
avant l’assemblage du prompt système. Si `SOUL_EVIL.md` est manquant ou vide,
OpenClaw consigne un avertissement et conserve le `SOUL.md` normal.

Les exécutions de sous-agents **n’incluent pas** `SOUL.md` dans leurs fichiers d’amorçage,
ce hook n’a donc aucun effet sur les sous-agents.

## Activation

```bash
openclaw hooks enable soul-evil
```

Puis définissez la configuration :

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

Créez `SOUL_EVIL.md` à la racine de l’espace de travail de l’agent (à côté de `SOUL.md`).

## Options

- `file` (string) : nom de fichier SOUL alternatif (par défaut : `SOUL_EVIL.md`)
- `chance` (nombre 0–1) : probabilité aléatoire par exécution d’utiliser `SOUL_EVIL.md`
- `purge.at` (HH:mm) : début quotidien de la purge (horloge 24 heures)
- `purge.duration` (durée) : longueur de la fenêtre (p. ex. `30s`, `10m`, `1h`)

**Priorité :** la fenêtre de purge l’emporte sur la probabilité.

**Fuseau horaire :** utilise `agents.defaults.userTimezone` lorsqu’il est défini ; sinon, le fuseau horaire de l’hôte.

## Remarques

- Aucun fichier n’est écrit ni modifié sur le disque.
- Si `SOUL.md` ne figure pas dans la liste d’amorçage, le hook ne fait rien.

## Voir aussi

- [Hooks](/hooks)
