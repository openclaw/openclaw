---
summary: "Surfaces de journalisation, logs fichier, styles WS log et formatage console"
read_when:
  - Modification de la sortie ou des formats de journalisation
  - Débogage de sortie CLI ou passerelle
title: "Journalisation"
---

# Journalisation

Pour un aperçu orienté utilisateur (CLI + UI de contrôle + config), voir [/fr-FR/logging](/fr-FR/logging).

OpenClaw a deux "surfaces" de log :

- **Sortie console** (ce que vous voyez dans le terminal / UI de débogage).
- **Logs fichier** (lignes JSON) écrits par le logger passerelle.

## Logger basé fichier

- Le fichier de log rotatif par défaut est sous `/tmp/openclaw/` (un fichier par jour) : `openclaw-YYYY-MM-DD.log`
  - La date utilise le fuseau horaire local de l'hôte passerelle.
- Le chemin du fichier de log et le niveau peuvent être configurés via `~/.openclaw/openclaw.json` :
  - `logging.file`
  - `logging.level`

Le format de fichier est un objet JSON par ligne.

L'onglet Logs de l'UI de contrôle suit ce fichier via la passerelle (`logs.tail`). Le CLI peut faire de même :

```bash
openclaw logs --follow
```

**Verbose vs. niveaux de log**

- **Les logs fichier** sont contrôlés exclusivement par `logging.level`.
- `--verbose` n'affecte que **la verbosité console** (et le style log WS) ; il ne **relève pas** le niveau de log fichier.
- Pour capturer les détails verbose-uniquement dans les logs fichier, définissez `logging.level` à `debug` ou `trace`.

## Capture console

Le CLI capture `console.log/info/warn/error/debug/trace` et les écrit dans les logs fichier, tout en imprimant toujours vers stdout/stderr.

Vous pouvez ajuster la verbosité console indépendamment via :

- `logging.consoleLevel` (défaut `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## Redaction de résumé d'outil

Les résumés d'outils verbeux (par ex. `🛠️ Exec: ...`) peuvent masquer les tokens sensibles avant qu'ils n'atteignent le flux console. C'est **outils uniquement** et ne modifie pas les logs fichier.

- `logging.redactSensitive` : `off` | `tools` (défaut : `tools`)
- `logging.redactPatterns` : tableau de chaînes regex (remplace les défauts)
  - Utilisez des chaînes regex brutes (auto `gi`), ou `/pattern/flags` si vous avez besoin de drapeaux personnalisés.
  - Les correspondances sont masquées en gardant les 6 premiers + 4 derniers caractères (longueur >= 18), sinon `***`.
  - Les défauts couvrent les affectations de clés courantes, drapeaux CLI, champs JSON, en-têtes bearer, blocs PEM et préfixes de token populaires.

## Logs WebSocket Passerelle

La passerelle imprime les logs de protocole WebSocket en deux modes :

- **Mode normal (pas de `--verbose`)** : seuls les résultats RPC "intéressants" sont imprimés :
  - erreurs (`ok=false`)
  - appels lents (seuil par défaut : `>= 50ms`)
  - erreurs d'analyse
- **Mode verbose (`--verbose`)** : imprime tout le trafic requête/réponse WS.

### Style log WS

`openclaw gateway` supporte un switch de style par passerelle :

- `--ws-log auto` (défaut) : le mode normal est optimisé ; le mode verbose utilise une sortie compacte
- `--ws-log compact` : sortie compacte (requête/réponse appariée) en mode verbose
- `--ws-log full` : sortie complète par trame en mode verbose
- `--compact` : alias pour `--ws-log compact`

Exemples :

```bash
# optimisé (seulement erreurs/lent)
openclaw gateway

# afficher tout le trafic WS (apparié)
openclaw gateway --verbose --ws-log compact

# afficher tout le trafic WS (méta complète)
openclaw gateway --verbose --ws-log full
```

## Formatage console (journalisation par sous-système)

Le formateur console est **conscient TTY** et imprime des lignes cohérentes avec préfixes. Les loggers de sous-système gardent la sortie groupée et scannable.

Comportement :

- **Préfixes de sous-système** sur chaque ligne (par ex. `[gateway]`, `[canvas]`, `[tailscale]`)
- **Couleurs de sous-système** (stables par sous-système) plus coloration de niveau
- **Couleur lorsque la sortie est un TTY ou l'environnement ressemble à un terminal riche** (`TERM`/`COLORTERM`/`TERM_PROGRAM`), respecte `NO_COLOR`
- **Préfixes de sous-système raccourcis** : supprime le `gateway/` et `channels/` de tête, garde les 2 derniers segments (par ex. `whatsapp/outbound`)
- **Sous-loggers par sous-système** (préfixe auto + champ structuré `{ subsystem }`)
- **`logRaw()`** pour sortie QR/UX (pas de préfixe, pas de formatage)
- **Styles console** (par ex. `pretty | compact | json`)
- **Niveau log console** séparé du niveau log fichier (le fichier garde les détails complets quand `logging.level` est défini à `debug`/`trace`)
- **Corps de message WhatsApp** sont journalisés à `debug` (utilisez `--verbose` pour les voir)

Cela garde les logs fichier existants stables tout en rendant la sortie interactive scannable.
