---
summary: "Flags de diagnostics pour journaux de débogage ciblés"
read_when:
  - Vous avez besoin de journaux de débogage ciblés sans augmenter les niveaux de journalisation globaux
  - Vous devez capturer des journaux spécifiques au sous-système pour le support
title: "Flags de diagnostics"
---

# Flags de diagnostics

Les flags de diagnostics vous permettent d'activer des journaux de débogage ciblés sans activer la journalisation verbeuse partout. Les flags sont opt-in et n'ont aucun effet sauf si un sous-système les vérifie.

## Comment ça fonctionne

- Les flags sont des chaînes (insensibles à la casse).
- Vous pouvez activer les flags dans la config ou via un remplacement d'env.
- Les wildcards sont supportés :
  - `telegram.*` correspond à `telegram.http`
  - `*` active tous les flags

## Activer via config

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Plusieurs flags :

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

Redémarrez la passerelle après avoir modifié les flags.

## Remplacement env (unique)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Désactiver tous les flags :

```bash
OPENCLAW_DIAGNOSTICS=0
```

## Où vont les journaux

Les flags émettent des journaux dans le fichier de journal de diagnostics standard. Par défaut :

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Si vous définissez `logging.file`, utilisez ce chemin à la place. Les journaux sont en JSONL (un objet JSON par ligne). La rédaction s'applique toujours selon `logging.redactSensitive`.

## Extraire les journaux

Choisir le dernier fichier journal :

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Filtrer pour les diagnostics HTTP Telegram :

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

Ou tail pendant la reproduction :

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

Pour les passerelles distantes, vous pouvez aussi utiliser `openclaw logs --follow` (voir [/cli/logs](/fr-FR/cli/logs)).

## Notes

- Si `logging.level` est défini plus haut que `warn`, ces journaux peuvent être supprimés. Le `info` par défaut convient.
- Les flags peuvent être laissés activés en toute sécurité ; ils affectent uniquement le volume de journaux pour le sous-système spécifique.
- Utilisez [/logging](/fr-FR/logging) pour changer les destinations, niveaux et rédaction des journaux.
