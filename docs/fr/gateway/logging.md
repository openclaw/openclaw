---
summary: "Surfaces de journalisation, journaux de fichiers, styles de journaux WS et formatage de la console"
read_when:
  - Modification de la sortie ou des formats de journalisation
  - Depannage de la sortie du CLI ou de la passerelle
title: "Journalisation"
---

# Journalisation

Pour une vue d’ensemble orientee utilisateur (CLI + UI de controle + configuration), voir [/logging](/logging).

OpenClaw propose deux « surfaces » de journalisation :

- **Sortie console** (ce que vous voyez dans le terminal / l’UI de debug).
- **Journaux de fichiers** (lignes JSON) ecrits par le logger de la Gateway (passerelle).

## Logger base sur des fichiers

- Le fichier de journalisation tournant par defaut se trouve sous `/tmp/openclaw/` (un fichier par jour) : `openclaw-YYYY-MM-DD.log`
  - La date utilise le fuseau horaire local de l’hote de la passerelle.
- Le chemin du fichier de logs et le niveau peuvent etre configures via `~/.openclaw/openclaw.json` :
  - `logging.file`
  - `logging.level`

Le format du fichier est un objet JSON par ligne.

L’onglet Logs de l’UI de controle suit ce fichier via la passerelle (`logs.tail`).
Le CLI peut faire de meme :

```bash
openclaw logs --follow
```

**Verbose vs. niveaux de logs**

- Les **journaux de fichiers** sont controles exclusivement par `logging.level`.
- `--verbose` affecte uniquement la **verbeuxite de la console** (et le style de logs WS) ; il n’augmente **pas**
  le niveau des journaux de fichiers.
- Pour capturer des details uniquement verbeux dans les journaux de fichiers, definissez `logging.level` sur `debug` ou
  `trace`.

## Capture de la console

Le CLI capture `console.log/info/warn/error/debug/trace` et les ecrit dans les journaux de fichiers,
tout en continuant a les afficher sur stdout/stderr.

Vous pouvez ajuster independamment la verbeuxite de la console via :

- `logging.consoleLevel` (par defaut `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## Redaction des resumes d’outils

Les resumes d’outils verbeux (par ex. `🛠️ Exec: ...`) peuvent masquer les jetons sensibles avant qu’ils n’atteignent le
flux de la console. Cela concerne **uniquement les outils** et ne modifie pas les journaux de fichiers.

- `logging.redactSensitive` : `off` | `tools` (par defaut : `tools`)
- `logging.redactPatterns` : tableau de chaines regex (remplace les valeurs par defaut)
  - Utilisez des chaines regex brutes (auto `gi`), ou `/pattern/flags` si vous avez besoin de drapeaux personnalises.
  - Les correspondances sont masquees en conservant les 6 premiers + les 4 derniers caracteres (longueur >= 18), sinon `***`.
  - Les valeurs par defaut couvrent les affectations de cles courantes, les drapeaux CLI, les champs JSON, les en-tetes bearer, les blocs PEM et les prefixes de jetons populaires.

## Journaux WebSocket de la Gateway (passerelle)

La passerelle affiche les journaux du protocole WebSocket selon deux modes :

- **Mode normal (sans `--verbose`)** : seuls les resultats RPC « interessants » sont affiches :
  - erreurs (`ok=false`)
  - appels lents (seuil par defaut : `>= 50ms`)
  - erreurs d’analyse
- **Mode verbeux (`--verbose`)** : affiche tout le trafic requete/reponse WS.

### Style de logs WS

`openclaw gateway` prend en charge un changement de style par passerelle :

- `--ws-log auto` (par defaut) : le mode normal est optimise ; le mode verbeux utilise une sortie compacte
- `--ws-log compact` : sortie compacte (requete/reponse appariees) en mode verbeux
- `--ws-log full` : sortie complete par trame en mode verbeux
- `--compact` : alias de `--ws-log compact`

Exemples :

```bash
# optimized (only errors/slow)
openclaw gateway

# show all WS traffic (paired)
openclaw gateway --verbose --ws-log compact

# show all WS traffic (full meta)
openclaw gateway --verbose --ws-log full
```

## Formatage de la console (journalisation par sous-systeme)

Le formateur de console est **conscient du TTY** et affiche des lignes coherentes avec des prefixes.
Les loggers de sous-systemes conservent une sortie regroupee et facilement lisible.

Comportement :

- **Prefixes de sous-systeme** sur chaque ligne (par ex. `[gateway]`, `[canvas]`, `[tailscale]`)
- **Couleurs par sous-systeme** (stables par sous-systeme) en plus de la coloration par niveau
- **Couleur lorsque la sortie est un TTY ou que l’environnement ressemble a un terminal riche** (`TERM`/`COLORTERM`/`TERM_PROGRAM`), respecte `NO_COLOR`
- **Prefixes de sous-systeme raccourcis** : supprime les prefixes initiaux `gateway/` + `channels/`, conserve les 2 derniers segments (par ex. `whatsapp/outbound`)
- **Sous-loggers par sous-systeme** (prefixe automatique + champ structure `{ subsystem }`)
- **`logRaw()`** pour la sortie QR/UX (pas de prefixe, pas de formatage)
- **Styles de console** (par ex. `pretty | compact | json`)
- **Niveau de logs console** distinct du niveau de logs fichiers (le fichier conserve tous les details lorsque `logging.level` est defini sur `debug`/`trace`)
- **Les corps de messages WhatsApp** sont journalises au niveau `debug` (utilisez `--verbose` pour les voir)

Cela permet de conserver des journaux de fichiers stables tout en rendant la sortie interactive facilement analysable.
