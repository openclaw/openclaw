---
summary: "CLI de Passerelle OpenClaw (`openclaw gateway`) — exécuter, interroger et découvrir les passerelles"
read_when:
  - Exécution de la Passerelle depuis le CLI (dev ou serveurs)
  - Débogage de l'auth Passerelle, modes de liaison et connectivité
  - Découverte de passerelles via Bonjour (LAN + tailnet)
title: "gateway"
---

# CLI Passerelle

La Passerelle est le serveur WebSocket d'OpenClaw (canaux, nœuds, sessions, hooks).

Les sous-commandes de cette page vivent sous `openclaw gateway …`.

Docs connexes :

- [/gateway/bonjour](/fr-FR/gateway/bonjour)
- [/gateway/discovery](/fr-FR/gateway/discovery)
- [/gateway/configuration](/fr-FR/gateway/configuration)

## Exécuter la Passerelle

Exécuter un processus de Passerelle local :

```bash
openclaw gateway
```

Alias au premier plan :

```bash
openclaw gateway run
```

Notes :

- Par défaut, la Passerelle refuse de démarrer sauf si `gateway.mode=local` est défini dans `~/.openclaw/openclaw.json`. Utilisez `--allow-unconfigured` pour des exécutions ad-hoc/dev.
- La liaison au-delà du loopback sans auth est bloquée (garde-fou de sécurité).
- `SIGUSR1` déclenche un redémarrage en processus quand autorisé (activez `commands.restart` ou utilisez l'outil gateway/config apply/update).
- Les gestionnaires `SIGINT`/`SIGTERM` arrêtent le processus de passerelle, mais ils ne restaurent pas l'état terminal personnalisé. Si vous encapsulez le CLI avec un TUI ou une entrée en mode raw, restaurez le terminal avant la sortie.

### Options

- `--port <port>` : port WebSocket (par défaut vient de config/env ; habituellement `18789`).
- `--bind <loopback|lan|tailnet|auto|custom>` : mode de liaison du listener.
- `--auth <token|password>` : remplacement du mode d'auth.
- `--token <token>` : remplacement du token (définit également `OPENCLAW_GATEWAY_TOKEN` pour le processus).
- `--password <password>` : remplacement du mot de passe (définit également `OPENCLAW_GATEWAY_PASSWORD` pour le processus).
- `--tailscale <off|serve|funnel>` : exposer la Passerelle via Tailscale.
- `--tailscale-reset-on-exit` : réinitialiser la config Tailscale serve/funnel à l'arrêt.
- `--allow-unconfigured` : autoriser le démarrage de passerelle sans `gateway.mode=local` dans config.
- `--dev` : créer une config + espace de travail dev si manquant (ignore BOOTSTRAP.md).
- `--reset` : réinitialiser config dev + identifiants + sessions + espace de travail (nécessite `--dev`).
- `--force` : tuer tout listener existant sur le port sélectionné avant de démarrer.
- `--verbose` : logs verbeux.
- `--claude-cli-logs` : afficher uniquement les logs claude-cli dans la console (et activer son stdout/stderr).
- `--ws-log <auto|full|compact>` : style de log websocket (par défaut `auto`).
- `--compact` : alias pour `--ws-log compact`.
- `--raw-stream` : enregistrer les événements de flux de modèle bruts en jsonl.
- `--raw-stream-path <path>` : chemin jsonl de flux brut.

## Interroger une Passerelle en cours d'exécution

Toutes les commandes de requête utilisent WebSocket RPC.

Modes de sortie :

- Par défaut : lisible par l'humain (coloré en TTY).
- `--json` : JSON lisible par machine (pas de stylisation/spinner).
- `--no-color` (ou `NO_COLOR=1`) : désactiver ANSI tout en gardant la mise en page humaine.

Options partagées (quand supportées) :

- `--url <url>` : URL WebSocket de Passerelle.
- `--token <token>` : token de Passerelle.
- `--password <password>` : mot de passe de Passerelle.
- `--timeout <ms>` : timeout/budget (varie par commande).
- `--expect-final` : attendre une réponse "finale" (appels d'agent).

Note : quand vous définissez `--url`, le CLI ne se rabat pas sur les identifiants de config ou d'environnement.
Passez `--token` ou `--password` explicitement. L'absence d'identifiants explicites est une erreur.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` affiche le service de Passerelle (launchd/systemd/schtasks) plus une sonde RPC optionnelle.

```bash
openclaw gateway status
openclaw gateway status --json
```

Options :

- `--url <url>` : remplacer l'URL de sonde.
- `--token <token>` : auth token pour la sonde.
- `--password <password>` : auth mot de passe pour la sonde.
- `--timeout <ms>` : timeout de sonde (par défaut `10000`).
- `--no-probe` : ignorer la sonde RPC (vue service uniquement).
- `--deep` : scanner également les services au niveau système.

### `gateway probe`

`gateway probe` est la commande "déboguer tout". Elle sonde toujours :

- votre passerelle distante configurée (si définie), et
- localhost (loopback) **même si distant est configuré**.

Si plusieurs passerelles sont accessibles, elle les affiche toutes. Plusieurs passerelles sont supportées quand vous utilisez des profils/ports isolés (par ex., un bot de secours), mais la plupart des installations exécutent toujours une seule passerelle.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### Distant sur SSH (parité app Mac)

Le mode "Distant sur SSH" de l'app macOS utilise un port-forward local pour que la passerelle distante (qui peut être liée uniquement au loopback) devienne accessible à `ws://127.0.0.1:<port>`.

Équivalent CLI :

```bash
openclaw gateway probe --ssh user@gateway-host
```

Options :

- `--ssh <target>` : `user@host` ou `user@host:port` (port par défaut `22`).
- `--ssh-identity <path>` : fichier d'identité.
- `--ssh-auto` : choisir le premier hôte de passerelle découvert comme cible SSH (LAN/WAB uniquement).

Config (optionnelle, utilisée comme valeurs par défaut) :

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

Aide RPC de bas niveau.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Gérer le service de Passerelle

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

Notes :

- `gateway install` supporte `--port`, `--runtime`, `--token`, `--force`, `--json`.
- Les commandes de cycle de vie acceptent `--json` pour le scripting.

## Découvrir les passerelles (Bonjour)

`gateway discover` scanne les balises de Passerelle (`_openclaw-gw._tcp`).

- Multicast DNS-SD : `local.`
- Unicast DNS-SD (Bonjour Wide-Area) : choisissez un domaine (exemple : `openclaw.internal.`) et configurez un DNS fractionné + un serveur DNS ; voir [/gateway/bonjour](/fr-FR/gateway/bonjour)

Seules les passerelles avec découverte Bonjour activée (par défaut) annoncent la balise.

Les enregistrements de découverte Wide-Area incluent (TXT) :

- `role` (indice de rôle de passerelle)
- `transport` (indice de transport, par ex. `gateway`)
- `gatewayPort` (port WebSocket, habituellement `18789`)
- `sshPort` (port SSH ; par défaut `22` si non présent)
- `tailnetDns` (nom d'hôte MagicDNS, quand disponible)
- `gatewayTls` / `gatewayTlsSha256` (TLS activé + empreinte de certificat)
- `cliPath` (indice optionnel pour installations distantes)

### `gateway discover`

```bash
openclaw gateway discover
```

Options :

- `--timeout <ms>` : timeout par commande (browse/resolve) ; par défaut `2000`.
- `--json` : sortie lisible par machine (désactive également stylisation/spinner).

Exemples :

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
