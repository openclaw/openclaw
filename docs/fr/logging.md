---
summary: "Aperçu de la journalisation : journaux de fichiers, sortie console, suivi CLI et l’UI de contrôle"
read_when:
  - Vous avez besoin d’un aperçu de la journalisation adapté aux debutants
  - Vous souhaitez configurer les niveaux ou les formats de journalisation
  - Vous effectuez un depannage et devez trouver rapidement les journaux
title: "Journalisation"
---

# Journalisation

OpenClaw enregistre les journaux a deux endroits :

- **Journaux de fichiers** (lignes JSON) ecrits par la Gateway (passerelle).
- **Sortie console** affichee dans les terminaux et l’UI de controle.

Cette page explique ou se trouvent les journaux, comment les lire et comment
configurer les niveaux et les formats de journalisation.

## Où vivent les logs

Par defaut, la Gateway ecrit un fichier de journalisation avec rotation sous :

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

La date utilise le fuseau horaire local de l’hote de la gateway.

Vous pouvez remplacer ce chemin dans `~/.openclaw/openclaw.json` :

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## Comment lire les journaux

### CLI : suivi en direct (recommande)

Utilisez la CLI pour suivre le fichier de journalisation de la gateway via RPC :

```bash
openclaw logs --follow
```

Modes de sortie :

- **Sessions TTY** : lignes de journal structurees, colorees et lisibles.
- **Sessions non‑TTY** : texte brut.
- `--json` : JSON delimite par ligne (un evenement de journal par ligne).
- `--plain` : forcer le texte brut dans les sessions TTY.
- `--no-color` : desactiver les couleurs ANSI.

En mode JSON, la CLI emet des objets etiquetes `type` :

- `meta` : metadonnees du flux (fichier, curseur, taille)
- `log` : entree de journal analysee
- `notice` : indices de troncature / rotation
- `raw` : ligne de journal non analysee

Si la Gateway est inaccessible, la CLI affiche une courte indication pour executer :

```bash
openclaw doctor
```

### UI de controle (web)

L’onglet **Logs** de l’UI de controle suit le meme fichier a l’aide de `logs.tail`.
Voir [/web/control-ui](/web/control-ui) pour savoir comment l’ouvrir.

### Journaux par canal uniquement

Pour filtrer l’activite par canal (WhatsApp/Telegram/etc), utilisez :

```bash
openclaw channels logs --channel whatsapp
```

## Formats de journalisation

### Journaux de fichiers (JSONL)

Chaque ligne du fichier de journalisation est un objet JSON. La CLI et l’UI de
controle analysent ces entrees pour afficher une sortie structuree (heure,
niveau, sous-systeme, message).

### Sortie console

Les journaux console sont **compatibles TTY** et formates pour la lisibilite :

- Prefixes de sous-systeme (par ex. `gateway/channels/whatsapp`)
- Coloration par niveau (info/warn/error)
- Mode compact ou JSON optionnel

Le formatage de la console est controle par `logging.consoleStyle`.

## Configuration de la journalisation

Toute la configuration de la journalisation se trouve sous `logging` dans
`~/.openclaw/openclaw.json`.

```json
{
  "logging": {
    "level": "info",
    "file": "/tmp/openclaw/openclaw-YYYY-MM-DD.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",
    "redactSensitive": "tools",
    "redactPatterns": ["sk-.*"]
  }
}
```

### Niveaux de journalisation

- `logging.level` : niveau des **journaux de fichiers** (JSONL).
- `logging.consoleLevel` : niveau de verbosite de la **console**.

`--verbose` n’affecte que la sortie console ; il ne modifie pas les niveaux
des journaux de fichiers.

### Styles de console

`logging.consoleStyle` :

- `pretty` : convivial, colore, avec horodatages.
- `compact` : sortie plus compacte (ideal pour les longues sessions).
- `json` : JSON par ligne (pour les processeurs de journaux).

### Redaction

Les resumes d’outils peuvent masquer les jetons sensibles avant l’affichage en
console :

- `logging.redactSensitive` : `off` | `tools` (defaut : `tools`)
- `logging.redactPatterns` : liste de chaines regex pour remplacer l’ensemble par defaut

La suppression affecte **la sortie de la console seulement** et ne modifie pas le journal des fichiers.

## Diagnostics + OpenTelemetry

Les diagnostics sont des evenements structures, lisibles par machine, pour les
executions de modeles **et** la telemetrie des flux de messages (webhooks, mise en
file d’attente, etat de session). Ils ne **remplacent pas** les journaux ; ils
existent pour alimenter les metriques, les traces et d’autres exportateurs.

Les evenements de diagnostic sont emis en processus, mais les exportateurs ne se
rattachent que lorsque les diagnostics **et** le plugin d’exportation sont
actives.

### OpenTelemetry vs OTLP

- **OpenTelemetry (OTel)** : le modele de donnees + les SDK pour les traces, les
  metriques et les journaux.
- **OTLP** : le protocole filaire utilise pour exporter les donnees OTel vers un
  collecteur/backend.
- OpenClaw exporte via **OTLP/HTTP (protobuf)** aujourd’hui.

### Signaux exportes

- **Metriques** : compteurs + histogrammes (utilisation de jetons, flux de
  messages, mise en file d’attente).
- **Traces** : spans pour l’utilisation des modeles + le traitement des
  webhooks/messages.
- **Journaux** : exportes via OTLP lorsque `diagnostics.otel.logs` est active. Le volume
  de journaux peut etre eleve ; gardez `logging.level` et les filtres de
  l’exportateur a l’esprit.

### Catalogue des evenements de diagnostic

Utilisation des modeles :

- `model.usage` : jetons, cout, duree, contexte, fournisseur/modele/canal,
  identifiants de session.

Flux de messages :

- `webhook.received` : entree webhook par canal.
- `webhook.processed` : webhook traite + duree.
- `webhook.error` : erreurs du gestionnaire de webhooks.
- `message.queued` : message mis en file pour traitement.
- `message.processed` : resultat + duree + erreur optionnelle.

Files + sessions :

- `queue.lane.enqueue` : mise en file d’une voie de file de commandes + profondeur.
- `queue.lane.dequeue` : retrait d’une voie de file de commandes + temps d’attente.
- `session.state` : transition d’etat de session + raison.
- `session.stuck` : avertissement de session bloquee + age.
- `run.attempt` : metadonnees de nouvelle tentative/essai d’execution.
- `diagnostic.heartbeat` : compteurs agreges (webhooks/file/session).

### Activer les diagnostics (sans exportateur)

Utilisez ceci si vous souhaitez que les evenements de diagnostic soient
disponibles pour des plugins ou des puits personnalises :

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### Indicateurs de diagnostics (journaux cibles)

Utilisez des indicateurs pour activer des journaux de debogage cibles
supplementaires sans augmenter `logging.level`.
Les drapeaux sont insensibles à la casse et prennent en charge les jokers (par exemple `telegram.*` ou `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Surcharge d'Env (unique) :

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Notes :

- Les journaux d’indicateurs vont dans le fichier de journalisation standard
  (identique a `logging.file`).
- La sortie reste masquee selon `logging.redactSensitive`.
- Guide complet : [/diagnostics/flags](/diagnostics/flags).

### Exporter vers OpenTelemetry

Les diagnostics peuvent etre exportes via le plugin `diagnostics-otel`
(OTLP/HTTP). Cela fonctionne avec tout collecteur/backend OpenTelemetry qui
accepte OTLP/HTTP.

```json
{
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": {
        "enabled": true
      }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://otel-collector:4318",
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 0.2,
      "flushIntervalMs": 60000
    }
  }
}
```

Notes :

- Vous pouvez egalement activer le plugin avec `openclaw plugins enable diagnostics-otel`.
- `protocol` prend actuellement en charge uniquement `http/protobuf`. `grpc` est ignore.
- Les metriques incluent l’utilisation des jetons, le cout, la taille du
  contexte, la duree d’execution et des compteurs/histogrammes de flux de
  messages (webhooks, mise en file d’attente, etat de session, profondeur/attente
  de file).
- Les traces/metriques peuvent etre activees/desactivees avec `traces` /
  `metrics` (defaut : actif). Les traces incluent les spans d’utilisation
  des modeles ainsi que les spans de traitement des webhooks/messages lorsque
  cela est active.
- Definissez `headers` lorsque votre collecteur requiert une
  authentification.
- Variables d’environnement prises en charge : `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`.

### Metriques exportees (noms + types)

Utilisation des modeles :

- `openclaw.tokens` (compteur, attrs : `openclaw.token`, `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (compteur, attrs : `openclaw.channel`, `openclaw.provider`,
  `openclaw.model`)
- `openclaw.run.duration_ms` (histogramme, attrs : `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (histogramme, attrs : `openclaw.context`,
  `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

Flux de messages :

- `openclaw.webhook.received` (compteur, attrs : `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.error` (compteur, attrs : `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (histogramme, attrs : `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.message.queued` (compteur, attrs : `openclaw.channel`,
  `openclaw.source`)
- `openclaw.message.processed` (compteur, attrs : `openclaw.channel`,
  `openclaw.outcome`)
- `openclaw.message.duration_ms` (histogramme, attrs : `openclaw.channel`,
  `openclaw.outcome`)

Files + sessions :

- `openclaw.queue.lane.enqueue` (compteur, attrs : `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (compteur, attrs : `openclaw.lane`)
- `openclaw.queue.depth` (histogramme, attrs : `openclaw.lane` ou
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (histogramme, attrs : `openclaw.lane`)
- `openclaw.session.state` (compteur, attrs : `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (compteur, attrs : `openclaw.state`)
- `openclaw.session.stuck_age_ms` (histogramme, attrs : `openclaw.state`)
- `openclaw.run.attempt` (compteur, attrs : `openclaw.attempt`)

### Spans exportes (noms + attributs cles)

- `openclaw.model.usage`
  - `openclaw.channel`, `openclaw.provider`, `openclaw.model`
  - `openclaw.sessionKey`, `openclaw.sessionId`
  - `openclaw.tokens.*` (input/output/cache_read/cache_write/total)
- `openclaw.webhook.processed`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`,
    `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`, `openclaw.outcome`, `openclaw.chatId`,
    `openclaw.messageId`, `openclaw.sessionKey`, `openclaw.sessionId`,
    `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`, `openclaw.ageMs`, `openclaw.queueDepth`,
    `openclaw.sessionKey`, `openclaw.sessionId`

### Echantillonnage + vidage

- Echantillonnage des traces : `diagnostics.otel.sampleRate` (0,0–1,0, uniquement les spans racines).
- Intervalle d’export des metriques : `diagnostics.otel.flushIntervalMs` (min 1000 ms).

### Notes sur le protocole

- Les points de terminaison OTLP/HTTP peuvent etre definis via `diagnostics.otel.endpoint` ou
  `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Si le point de terminaison contient deja `/v1/traces` ou `/v1/metrics`,
  il est utilise tel quel.
- Si le point de terminaison contient deja `/v1/logs`, il est utilise tel
  quel pour les journaux.
- `diagnostics.otel.logs` active l’export des journaux OTLP pour la sortie du journal
  principal.

### Comportement de l’export des journaux

- Les journaux OTLP utilisent les memes enregistrements structures ecrits dans
  `logging.file`.
- Respecte `logging.level` (niveau des journaux de fichiers). Le masquage de la
  console ne s’applique **pas** aux journaux OTLP.
- Les installations a fort volume devraient privilegier l’echantillonnage/le
  filtrage au niveau du collecteur OTLP.

## Conseils de depannage

- **Gateway inaccessible ?** Executez d’abord `openclaw doctor`.
- **Journaux vides ?** Verifiez que la Gateway est en cours d’execution et qu’elle
  ecrit vers le chemin de fichier indique dans `logging.file`.
- **Besoin de plus de details ?** Definissez `logging.level` sur
  `debug` ou `trace` et reessayez.
