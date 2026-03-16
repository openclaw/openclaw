---
summary: "Aperçu de la journalisation : journaux de fichiers, sortie console, suivi CLI et UI de Contrôle"
read_when:
  - Vous avez besoin d'un aperçu facile de la journalisation
  - Vous voulez configurer les niveaux ou formats de journal
  - Vous déboguez et devez trouver rapidement les journaux
title: "Journalisation"
---

# Journalisation

OpenClaw enregistre dans deux endroits :

- **Journaux de fichiers** (lignes JSON) écrits par la Passerelle.
- **Sortie console** affichée dans les terminaux et l'UI de Contrôle.

Cette page explique où vivent les journaux, comment les lire et comment configurer les niveaux et formats de journal.

## Où vivent les journaux

Par défaut, la Passerelle écrit un fichier journal rotatif sous :

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

La date utilise le fuseau horaire local de l'hôte de la passerelle.

Vous pouvez remplacer ceci dans `~/.openclaw/openclaw.json` :

```json
{
  "logging": {
    "file": "/chemin/vers/openclaw.log"
  }
}
```

## Comment lire les journaux

### CLI : suivi en direct (recommandé)

Utilisez la CLI pour suivre le fichier journal de la passerelle via RPC :

```bash
openclaw logs --follow
```

Modes de sortie :

- **Sessions TTY** : jolies lignes de journal structurées et colorées.
- **Sessions non-TTY** : texte brut.
- `--json` : JSON délimité par ligne (un événement de journal par ligne).
- `--plain` : force le texte brut dans les sessions TTY.
- `--no-color` : désactive les couleurs ANSI.

En mode JSON, la CLI émet des objets balisés `type` :

- `meta` : métadonnées de flux (fichier, curseur, taille)
- `log` : entrée de journal analysée
- `notice` : indications de troncature / rotation
- `raw` : ligne de journal non analysée

Si la Passerelle est inaccessible, la CLI affiche une brève indication pour exécuter :

```bash
openclaw doctor
```

### UI de Contrôle (web)

L'onglet **Logs** de l'UI de Contrôle suit le même fichier en utilisant `logs.tail`.
Voir [/fr-FR/web/control-ui](/fr-FR/web/control-ui) pour savoir comment l'ouvrir.

### Journaux spécifiques au canal

Pour filtrer l'activité de canal (WhatsApp/Telegram/etc), utilisez :

```bash
openclaw channels logs --channel whatsapp
```

## Formats de journal

### Journaux de fichiers (JSONL)

Chaque ligne dans le fichier journal est un objet JSON. La CLI et l'UI de Contrôle analysent ces entrées pour rendre une sortie structurée (heure, niveau, sous-système, message).

### Sortie console

Les journaux de console sont **conscients du TTY** et formatés pour la lisibilité :

- Préfixes de sous-système (par ex., `gateway/channels/whatsapp`)
- Coloration par niveau (info/warn/error)
- Mode compact ou JSON optionnel

Le formatage de la console est contrôlé par `logging.consoleStyle`.

## Configurer la journalisation

Toute la configuration de journalisation vit sous `logging` dans `~/.openclaw/openclaw.json`.

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

### Niveaux de journal

- `logging.level` : niveau des **journaux de fichiers** (JSONL).
- `logging.consoleLevel` : niveau de verbosité **console**.

`--verbose` n'affecte que la sortie console ; il ne change pas les niveaux de journal de fichiers.

### Styles de console

`logging.consoleStyle` :

- `pretty` : convivial, coloré, avec horodatages.
- `compact` : sortie plus serrée (meilleur pour longues sessions).
- `json` : JSON par ligne (pour processeurs de journaux).

### Rédaction

Les résumés d'outil peuvent rédiger les jetons sensibles avant qu'ils atteignent la console :

- `logging.redactSensitive` : `off` | `tools` (par défaut : `tools`)
- `logging.redactPatterns` : liste de chaînes regex pour remplacer l'ensemble par défaut

La rédaction affecte **la sortie console uniquement** et ne modifie pas les journaux de fichiers.

## Diagnostics + OpenTelemetry

Les diagnostics sont des événements structurés, lisibles par machine pour les exécutions de modèle **et** la télémétrie de flux de messages (webhooks, files d'attente, état de session). Ils ne **remplacent pas** les journaux ; ils existent pour alimenter des métriques, traces et autres exportateurs.

Les événements de diagnostics sont émis dans le processus, mais les exportateurs ne s'attachent que lorsque les diagnostics + le plugin exportateur sont activés.

### OpenTelemetry vs OTLP

- **OpenTelemetry (OTel)** : le modèle de données + SDK pour traces, métriques et journaux.
- **OTLP** : le protocole filaire utilisé pour exporter les données OTel vers un collecteur/backend.
- OpenClaw exporte via **OTLP/HTTP (protobuf)** aujourd'hui.

### Signaux exportés

- **Métriques** : compteurs + histogrammes (utilisation de jetons, flux de messages, files d'attente).
- **Traces** : spans pour utilisation de modèle + traitement webhook/message.
- **Journaux** : exportés via OTLP quand `diagnostics.otel.logs` est activé. Le volume de journaux peut être élevé ; gardez `logging.level` et les filtres d'exportateur à l'esprit.

### Catalogue d'événements de diagnostic

Utilisation de modèle :

- `model.usage` : jetons, coût, durée, contexte, fournisseur/modèle/canal, identifiants de session.

Flux de messages :

- `webhook.received` : ingestion de webhook par canal.
- `webhook.processed` : webhook géré + durée.
- `webhook.error` : erreurs de gestionnaire webhook.
- `message.queued` : message mis en file d'attente pour traitement.
- `message.processed` : résultat + durée + erreur optionnelle.

File d'attente + session :

- `queue.lane.enqueue` : mise en file d'attente de voie de file de commande + profondeur.
- `queue.lane.dequeue` : défilement de voie de file de commande + temps d'attente.
- `session.state` : transition d'état de session + raison.
- `session.stuck` : avertissement de session bloquée + âge.
- `run.attempt` : métadonnées de tentative/reprise d'exécution.
- `diagnostic.heartbeat` : compteurs agrégés (webhooks/file/session).

### Activer les diagnostics (sans exportateur)

Utilisez ceci si vous voulez que les événements de diagnostics soient disponibles pour les plugins ou récepteurs personnalisés :

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### Drapeaux de diagnostics (journaux ciblés)

Utilisez des drapeaux pour activer des journaux de débogage supplémentaires, ciblés sans élever `logging.level`. Les drapeaux sont insensibles à la casse et supportent les jokers (par ex., `telegram.*` ou `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Remplacement d'environnement (ponctuel) :

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Notes :

- Les journaux de drapeau vont au fichier journal standard (même que `logging.file`).
- La sortie est toujours rédagée selon `logging.redactSensitive`.
- Guide complet : [/fr-FR/diagnostics/flags](/fr-FR/diagnostics/flags).

### Exporter vers OpenTelemetry

Les diagnostics peuvent être exportés via le plugin `diagnostics-otel` (OTLP/HTTP). Cela fonctionne avec n'importe quel collecteur/backend OpenTelemetry qui accepte OTLP/HTTP.

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

Notes :

- Vous pouvez aussi activer le plugin avec `openclaw plugins enable diagnostics-otel`.
- `protocol` supporte actuellement `http/protobuf` uniquement. `grpc` est ignoré.
- Les métriques incluent l'utilisation de jetons, le coût, la taille de contexte, la durée d'exécution et les compteurs/histogrammes de flux de messages (webhooks, files d'attente, état de session, profondeur/attente de file).
- Les traces/métriques peuvent être basculées avec `traces` / `metrics` (par défaut : activé). Les traces incluent des spans d'utilisation de modèle plus des spans de traitement webhook/message quand activé.
- Définissez `headers` quand votre collecteur nécessite une authentification.
- Variables d'environnement supportées : `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`.

### Métriques exportées (noms + types)

Utilisation de modèle :

- `openclaw.tokens` (compteur, attrs : `openclaw.token`, `openclaw.channel`, `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (compteur, attrs : `openclaw.channel`, `openclaw.provider`, `openclaw.model`)
- `openclaw.run.duration_ms` (histogramme, attrs : `openclaw.channel`, `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (histogramme, attrs : `openclaw.context`, `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

Flux de messages :

- `openclaw.webhook.received` (compteur, attrs : `openclaw.channel`, `openclaw.webhook`)
- `openclaw.webhook.error` (compteur, attrs : `openclaw.channel`, `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (histogramme, attrs : `openclaw.channel`, `openclaw.webhook`)
- `openclaw.message.queued` (compteur, attrs : `openclaw.channel`, `openclaw.source`)
- `openclaw.message.processed` (compteur, attrs : `openclaw.channel`, `openclaw.outcome`)
- `openclaw.message.duration_ms` (histogramme, attrs : `openclaw.channel`, `openclaw.outcome`)

Files d'attente + sessions :

- `openclaw.queue.lane.enqueue` (compteur, attrs : `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (compteur, attrs : `openclaw.lane`)
- `openclaw.queue.depth` (histogramme, attrs : `openclaw.lane` ou `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (histogramme, attrs : `openclaw.lane`)
- `openclaw.session.state` (compteur, attrs : `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (compteur, attrs : `openclaw.state`)
- `openclaw.session.stuck_age_ms` (histogramme, attrs : `openclaw.state`)
- `openclaw.run.attempt` (compteur, attrs : `openclaw.attempt`)

### Spans exportés (noms + attributs clés)

- `openclaw.model.usage`
  - `openclaw.channel`, `openclaw.provider`, `openclaw.model`
  - `openclaw.sessionKey`, `openclaw.sessionId`
  - `openclaw.tokens.*` (input/output/cache_read/cache_write/total)
- `openclaw.webhook.processed`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`, `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`, `openclaw.outcome`, `openclaw.chatId`, `openclaw.messageId`, `openclaw.sessionKey`, `openclaw.sessionId`, `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`, `openclaw.ageMs`, `openclaw.queueDepth`, `openclaw.sessionKey`, `openclaw.sessionId`

### Échantillonnage + vidage

- Échantillonnage de trace : `diagnostics.otel.sampleRate` (0.0–1.0, spans racine uniquement).
- Intervalle d'export de métrique : `diagnostics.otel.flushIntervalMs` (min 1000ms).

### Notes de protocole

- Les points de terminaison OTLP/HTTP peuvent être définis via `diagnostics.otel.endpoint` ou `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Si le point de terminaison contient déjà `/v1/traces` ou `/v1/metrics`, il est utilisé tel quel.
- Si le point de terminaison contient déjà `/v1/logs`, il est utilisé tel quel pour les journaux.
- `diagnostics.otel.logs` active l'export de journal OTLP pour la sortie de journalisation principale.

### Comportement d'export de journal

- Les journaux OTLP utilisent les mêmes enregistrements structurés écrits dans `logging.file`.
- Respecte `logging.level` (niveau de journal de fichier). La rédaction console ne s'applique **pas** aux journaux OTLP.
- Les installations à volume élevé devraient préférer l'échantillonnage/filtrage du collecteur OTLP.

## Conseils de dépannage

- **Passerelle inaccessible ?** Exécutez d'abord `openclaw doctor`.
- **Journaux vides ?** Vérifiez que la Passerelle s'exécute et écrit dans le chemin de fichier dans `logging.file`.
- **Besoin de plus de détails ?** Définissez `logging.level` à `debug` ou `trace` et réessayez.
