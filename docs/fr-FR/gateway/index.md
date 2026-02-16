---
summary: "Guide opérationnel pour le service passerelle, cycle de vie et opérations"
read_when:
  - Exécution ou débogage du processus passerelle
title: "Guide de la Passerelle"
---

# Guide de la passerelle

Utilisez cette page pour le démarrage au jour 1 et les opérations au jour 2 du service de passerelle.

<CardGroup cols={2}>
  <Card title="Dépannage approfondi" icon="siren" href="/fr-FR/gateway/troubleshooting">
    Diagnostics basés sur les symptômes avec échelles de commandes exactes et signatures de journaux.
  </Card>
  <Card title="Configuration" icon="sliders" href="/fr-FR/gateway/configuration">
    Guide de configuration orienté tâches + référence de configuration complète.
  </Card>
</CardGroup>

## Démarrage local en 5 minutes

<Steps>
  <Step title="Démarrer la passerelle">

```bash
openclaw gateway --port 18789
# debug/trace reflété vers stdio
openclaw gateway --port 18789 --verbose
# forcer l'arrêt du listener sur le port sélectionné, puis démarrer
openclaw gateway --force
```

  </Step>

  <Step title="Vérifier la santé du service">

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
```

Ligne de base saine : `Runtime: running` et `RPC probe: ok`.

  </Step>

  <Step title="Valider la disponibilité des canaux">

```bash
openclaw channels status --probe
```

  </Step>
</Steps>

<Note>
Le rechargement de configuration de la passerelle surveille le chemin du fichier de configuration actif (résolu depuis les valeurs par défaut du profil/état, ou `OPENCLAW_CONFIG_PATH` s'il est défini).
Le mode par défaut est `gateway.reload.mode="hybrid"`.
</Note>

## Modèle d'exécution

- Un processus toujours actif pour le routage, le plan de contrôle et les connexions de canaux.
- Port multiplexé unique pour :
  - WebSocket control/RPC
  - API HTTP (compatible OpenAI, Responses, invocation d'outils)
  - UI de contrôle et hooks
- Mode de liaison par défaut : `loopback`.
- L'authentification est requise par défaut (`gateway.auth.token` / `gateway.auth.password`, ou `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`).

### Précédence du port et de la liaison

| Paramètre       | Ordre de résolution                                           |
| --------------- | ------------------------------------------------------------- |
| Port passerelle | `--port` → `OPENCLAW_GATEWAY_PORT` → `gateway.port` → `18789` |
| Mode de liaison | CLI/override → `gateway.bind` → `loopback`                    |

### Modes de rechargement à chaud

| `gateway.reload.mode` | Comportement                                             |
| --------------------- | -------------------------------------------------------- |
| `off`                 | Pas de rechargement de configuration                     |
| `hot`                 | Applique uniquement les changements sûrs à chaud         |
| `restart`             | Redémarre lors de changements nécessitant un redémarrage |
| `hybrid` (par défaut) | Application à chaud si sûr, redémarrage si nécessaire    |

## Ensemble de commandes opérateur

```bash
openclaw gateway status
openclaw gateway status --deep
openclaw gateway status --json
openclaw gateway install
openclaw gateway restart
openclaw gateway stop
openclaw logs --follow
openclaw doctor
```

## Accès distant

Préféré : Tailscale/VPN.
Solution de secours : tunnel SSH.

```bash
ssh -N -L 18789:127.0.0.1:18789 utilisateur@hôte
```

Ensuite, connectez les clients à `ws://127.0.0.1:18789` localement.

<Warning>
Si l'authentification de la passerelle est configurée, les clients doivent toujours envoyer l'authentification (`token`/`password`) même via les tunnels SSH.
</Warning>

Voir : [Passerelle distante](/fr-FR/gateway/remote), [Authentification](/fr-FR/gateway/authentication), [Tailscale](/fr-FR/gateway/tailscale).

## Supervision et cycle de vie du service

Utilisez des exécutions supervisées pour une fiabilité de type production.

<Tabs>
  <Tab title="macOS (launchd)">

```bash
openclaw gateway install
openclaw gateway status
openclaw gateway restart
openclaw gateway stop
```

Les labels LaunchAgent sont `ai.openclaw.gateway` (par défaut) ou `ai.openclaw.<profil>` (profil nommé). `openclaw doctor` audite et répare la dérive de configuration du service.

  </Tab>

  <Tab title="Linux (systemd user)">

```bash
openclaw gateway install
systemctl --user enable --now openclaw-gateway[-<profil>].service
openclaw gateway status
```

Pour la persistance après la déconnexion, activez le lingering :

```bash
sudo loginctl enable-linger <utilisateur>
```

  </Tab>

  <Tab title="Linux (service système)">

Utilisez une unité système pour les hôtes multi-utilisateurs/toujours actifs.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profil>].service
```

  </Tab>
</Tabs>

## Plusieurs passerelles sur un hôte

La plupart des configurations devraient exécuter **une** passerelle.
N'utilisez plusieurs que pour une isolation/redondance stricte (par exemple un profil de secours).

Liste de contrôle par instance :

- `gateway.port` unique
- `OPENCLAW_CONFIG_PATH` unique
- `OPENCLAW_STATE_DIR` unique
- `agents.defaults.workspace` unique

Exemple :

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

Voir : [Plusieurs passerelles](/fr-FR/gateway/multiple-gateways).

### Chemin rapide du profil dev

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
openclaw --dev status
```

Les valeurs par défaut incluent un état/configuration isolé et un port de passerelle de base `19001`.

## Référence rapide du protocole (vue opérateur)

- La première trame client doit être `connect`.
- La passerelle renvoie un snapshot `hello-ok` (`presence`, `health`, `stateVersion`, `uptimeMs`, limits/policy).
- Requêtes : `req(method, params)` → `res(ok/payload|error)`.
- Événements courants : `connect.challenge`, `agent`, `chat`, `presence`, `tick`, `health`, `heartbeat`, `shutdown`.

Les exécutions d'agents se font en deux étapes :

1. Acquittement accepté immédiat (`status:"accepted"`)
2. Réponse de complétion finale (`status:"ok"|"error"`), avec des événements `agent` streamés entre les deux.

Voir la documentation complète du protocole : [Protocole de la passerelle](/fr-FR/gateway/protocol).

## Vérifications opérationnelles

### Vivacité

- Ouvrez un WS et envoyez `connect`.
- Attendez la réponse `hello-ok` avec snapshot.

### Disponibilité

```bash
openclaw gateway status
openclaw channels status --probe
openclaw health
```

### Récupération d'écart

Les événements ne sont pas rejoués. En cas d'écarts de séquence, rafraîchissez l'état (`health`, `system-presence`) avant de continuer.

## Signatures d'échec courantes

| Signature                                                      | Problème probable                                 |
| -------------------------------------------------------------- | ------------------------------------------------- |
| `refusing to bind gateway ... without auth`                    | Liaison non-loopback sans token/password          |
| `another gateway instance is already listening` / `EADDRINUSE` | Conflit de port                                   |
| `Gateway start blocked: set gateway.mode=local`                | Configuration en mode distant                     |
| `unauthorized` pendant connect                                 | Incompatibilité d'auth entre client et passerelle |

Pour les échelles de diagnostic complètes, utilisez [Dépannage de la passerelle](/fr-FR/gateway/troubleshooting).

## Garanties de sécurité

- Les clients du protocole de passerelle échouent rapidement quand la passerelle n'est pas disponible (pas de repli implicite direct-canal).
- Les premières trames invalides/non-connect sont rejetées et fermées.
- L'arrêt gracieux émet un événement `shutdown` avant la fermeture du socket.

---

Connexe :

- [Dépannage](/fr-FR/gateway/troubleshooting)
- [Processus en arrière-plan](/fr-FR/gateway/background-process)
- [Configuration](/fr-FR/gateway/configuration)
- [Santé](/fr-FR/gateway/health)
- [Doctor](/fr-FR/gateway/doctor)
- [Authentification](/fr-FR/gateway/authentication)
