---
summary: "CLI de l’OpenClaw Gateway (passerelle) (`openclaw gateway`) — exécuter, interroger et découvrir des gateways"
read_when:
  - Exécuter le Gateway depuis la CLI (dev ou serveurs)
  - Déboguer l’authentification du Gateway, les modes de liaison et la connectivité
  - Découvrir des gateways via Bonjour (LAN + tailnet)
title: "gateway"
---

# Gateway CLI

Le Gateway est le serveur WebSocket d’OpenClaw (canaux, nœuds, sessions, hooks).

Les sous-commandes de cette page se trouvent sous `openclaw gateway …`.

Docs associées :

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Exécuter le Gateway

Exécutez un processus Gateway local :

```bash
openclaw gateway
```

Alias de premier plan :

```bash
openclaw gateway run
```

Notes :

- Par défaut, le Gateway refuse de démarrer sauf si `gateway.mode=local` est défini dans `~/.openclaw/openclaw.json`. Utilisez `--allow-unconfigured` pour des exécutions ad hoc/dev.
- La liaison au-delà du loopback sans authentification est bloquée (garde-fou de sécurité).
- `SIGUSR1` déclenche un redémarrage en cours de processus lorsqu’il est autorisé (activez `commands.restart` ou utilisez l’outil gateway/config apply/update).
- Les gestionnaires `SIGINT`/`SIGTERM` arrêtent le processus du gateway, mais ne restaurent aucun état personnalisé du terminal. Si vous encapsulez la CLI avec une TUI ou une entrée en mode brut, restaurez le terminal avant de quitter.

### Options

- `--port <port>` : port WebSocket (la valeur par défaut provient de la config/env ; généralement `18789`).
- `--bind <loopback|lan|tailnet|auto|custom>` : mode de liaison de l’écouteur.
- `--auth <token|password>` : forçage du mode d’authentification.
- `--token <token>` : forçage du jeton (définit aussi `OPENCLAW_GATEWAY_TOKEN` pour le processus).
- `--password <password>` : forçage du mot de passe (définit aussi `OPENCLAW_GATEWAY_PASSWORD` pour le processus).
- `--tailscale <off|serve|funnel>` : exposer le Gateway via Tailscale.
- `--tailscale-reset-on-exit` : réinitialiser la configuration Tailscale serve/funnel à l’arrêt.
- `--allow-unconfigured` : autoriser le démarrage du gateway sans `gateway.mode=local` dans la config.
- `--dev` : créer une config + un espace de travail dev s’ils sont manquants (ignore BOOTSTRAP.md).
- `--reset` : réinitialiser la config dev + identifiants + sessions + espace de travail (nécessite `--dev`).
- `--force` : tuer tout écouteur existant sur le port sélectionné avant de démarrer.
- `--verbose` : journaux verbeux.
- `--claude-cli-logs` : afficher uniquement les journaux de claude-cli dans la console (et activer sa sortie stdout/stderr).
- `--ws-log <auto|full|compact>` : style des journaux websocket (par défaut `auto`).
- `--compact` : alias de `--ws-log compact`.
- `--raw-stream` : consigner les événements bruts du flux du modèle en jsonl.
- `--raw-stream-path <path>` : chemin du jsonl du flux brut.

## Interroger un Gateway en cours d’exécution

Toutes les commandes d’interrogation utilisent le RPC WebSocket.

Modes de sortie :

- Par défaut : lisible par un humain (coloré en TTY).
- `--json` : JSON lisible par machine (sans style/spinner).
- `--no-color` (ou `NO_COLOR=1`) : désactiver l’ANSI tout en conservant la mise en page humaine.

Options partagées (le cas échéant) :

- `--url <url>` : URL WebSocket du Gateway.
- `--token <token>` : jeton du Gateway.
- `--password <password>` : mot de passe du Gateway.
- `--timeout <ms>` : délai/budget (varie selon la commande).
- `--expect-final` : attendre une réponse « finale » (appels d’agent).

Remarque : lorsque vous définissez `--url`, la CLI ne retombe pas sur les identifiants de la config ou de l’environnement.
Passez `--token` ou `--password` explicitement. L’absence d’identifiants explicites est une erreur.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` affiche le service Gateway (launchd/systemd/schtasks) ainsi qu’une sonde RPC optionnelle.

```bash
openclaw gateway status
openclaw gateway status --json
```

Options :

- `--url <url>` : forcer l’URL de la sonde.
- `--token <token>` : authentification par jeton pour la sonde.
- `--password <password>` : authentification par mot de passe pour la sonde.
- `--timeout <ms>` : délai de la sonde (par défaut `10000`).
- `--no-probe` : ignorer la sonde RPC (vue service uniquement).
- `--deep` : analyser aussi les services au niveau système.

### `gateway probe`

`gateway probe` est la commande « tout déboguer ». Elle sonde toujours :

- votre gateway distant configuré (le cas échéant), et
- localhost (loopback) **même si un distant est configuré**.

Si plusieurs gateways sont joignables, elle les affiche tous. Les gateways multiples sont prises en charge lorsque vous utilisez des profils/ports isolés (p. ex. un bot de secours), mais la plupart des installations n’exécutent encore qu’un seul gateway.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### Distant via SSH (parité avec l’app Mac)

Le mode « Remote over SSH » de l’app macOS utilise un port-forward local afin que le gateway distant (qui peut être lié uniquement au loopback) devienne joignable à `ws://127.0.0.1:<port>`.

Équivalent CLI :

```bash
openclaw gateway probe --ssh user@gateway-host
```

Options :

- `--ssh <target>` : `user@host` ou `user@host:port` (le port par défaut est `22`).
- `--ssh-identity <path>` : fichier d’identité.
- `--ssh-auto` : choisir le premier hôte gateway découvert comme cible SSH (LAN/WAB uniquement).

Config (optionnelle, utilisée comme valeurs par défaut) :

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

Assistant RPC de bas niveau.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Gérer le service Gateway

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

Notes :

- `gateway install` prend en charge `--port`, `--runtime`, `--token`, `--force`, `--json`.
- Les commandes de cycle de vie acceptent `--json` pour le scripting.

## Découvrir des gateways (Bonjour)

`gateway discover` analyse les balises Gateway (`_openclaw-gw._tcp`).

- Multicast DNS-SD : `local.`
- Unicast DNS-SD (Wide-Area Bonjour) : choisissez un domaine (exemple : `openclaw.internal.`) et configurez un split DNS + un serveur DNS ; voir [/gateway/bonjour](/gateway/bonjour)

Seuls les gateways avec la découverte Bonjour activée (par défaut) annoncent la balise.

Les enregistrements de découverte Wide-Area incluent (TXT) :

- `role` (indice de rôle du gateway)
- `transport` (indice de transport, p. ex. `gateway`)
- `gatewayPort` (port WebSocket, généralement `18789`)
- `sshPort` (port SSH ; par défaut `22` s’il est absent)
- `tailnetDns` (nom d’hôte MagicDNS, lorsque disponible)
- `gatewayTls` / `gatewayTlsSha256` (TLS activé + empreinte du certificat)
- `cliPath` (indice optionnel pour les installations distantes)

### `gateway discover`

```bash
openclaw gateway discover
```

Options :

- `--timeout <ms>` : délai par commande (navigation/résolution) ; par défaut `2000`.
- `--json` : sortie lisible par machine (désactive aussi le style/spinner).

Exemples :

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
