---
summary: "Indicateurs de diagnostic pour des journaux de debogage cibles"
read_when:
  - Vous avez besoin de journaux de debogage cibles sans augmenter les niveaux de journalisation globaux
  - Vous devez capturer des journaux specifiques a un sous-systeme pour le support
title: "Indicateurs de diagnostic"
---

# Indicateurs de diagnostic

Les indicateurs de diagnostic vous permettent d’activer des journaux de debogage cibles sans activer une journalisation verbeuse partout. Les indicateurs sont opt-in et n’ont aucun effet tant qu’un sous-systeme ne les verifie pas.

## Fonctionnement

- Les marqueurs sont des chaînes (insensibles à la casse).
- Vous pouvez activer des indicateurs dans la configuration ou via une surcharge par variable d’environnement.
- Les jokers sont pris en charge :
  - `telegram.*` correspond a `telegram.http`
  - `*` active tous les indicateurs

## Activer via la configuration

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Plusieurs indicateurs :

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

Redemarrez le Gateway (passerelle) apres avoir modifie les indicateurs.

## Surcharge d'Env (unique)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Desactiver tous les indicateurs :

```bash
OPENCLAW_DIAGNOSTICS=0
```

## Où vont les logs

Les indicateurs emettent des journaux dans le fichier de diagnostics standard. Par defaut :

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Si vous definissez `logging.file`, ce chemin est utilise a la place. Les journaux sont au format JSONL (un objet JSON par ligne). La redaction s’applique toujours selon `logging.redactSensitive`.

## Extraire les journaux

Choisissez le fichier de journal le plus recent :

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Filtrer les diagnostics HTTP de Telegram :

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

Ou suivre en temps reel pendant la reproduction :

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

Pour les Gateway (passerelle) distants, vous pouvez egalement utiliser `openclaw logs --follow` (voir [/cli/logs](/cli/logs)).

## Notes

- Si `logging.level` est defini a un niveau superieur a `warn`, ces journaux peuvent etre supprimes. La valeur par defaut `info` convient.
- Les indicateurs peuvent rester actives sans risque ; ils n’affectent que le volume de journaux pour le sous-systeme specifique.
- Utilisez [/logging](/logging) pour modifier les destinations de journaux, les niveaux et la redaction.
