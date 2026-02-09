---
summary: "Application compagnon macOS OpenClaw (barre de menus + courtier de passerelle)"
read_when:
  - Implémentation de fonctionnalités de l’application macOS
  - Modification du cycle de vie de la passerelle ou du pontage de nœuds sur macOS
title: "Application macOS"
---

# Application compagnon macOS OpenClaw (barre de menus + courtier de passerelle)

L’application macOS est le **compagnon de barre de menus** pour OpenClaw. Elle gère les autorisations,
gère/s’attache à la Gateway (passerelle) localement (launchd ou manuel), et expose les
capacités macOS à l’agent sous forme de nœud.

## Ce qu’elle fait

- Affiche des notifications natives et l’état dans la barre de menus.
- Gère les invites TCC (Notifications, Accessibilité, Enregistrement de l’écran, Microphone,
  Reconnaissance vocale, Automation/AppleScript).
- Exécute ou se connecte à la Gateway (passerelle) (locale ou distante).
- Expose des outils spécifiques à macOS (Canvas, Camera, Screen Recording, `system.run`).
- Démarre le service hôte de nœud local en mode **remote**, et l’arrête en mode **local**.
- Peut héberger **PeekabooBridge** pour l’automatisation de l’interface utilisateur.
- Installe le CLI global (`openclaw`) via npm/pnpm sur demande (bun non recommandé pour l’exécution de la Gateway).

## Mode local vs mode distant

- **Local** (par défaut) : l’application s’attache à une Gateway locale en cours d’exécution si elle existe ;
  sinon, elle active le service launchd via `openclaw gateway install`.
- **Remote** : l’application se connecte à une Gateway via SSH/Tailscale et ne démarre jamais
  de processus local.
  L’application démarre le **service hôte de nœud** local afin que la Gateway distante puisse atteindre ce Mac.
  L’application ne lance pas la Gateway comme processus enfant.

## Contrôle launchd

L’application gère un LaunchAgent par utilisateur libellé `bot.molt.gateway`
(ou `bot.molt.<profile>` lors de l’utilisation de `--profile`/`OPENCLAW_PROFILE` ; l’ancien `com.openclaw.*` se décharge toujours).

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Remplacez le libellé par `bot.molt.<profile>` lors de l’exécution d’un profil nommé.

Si le LaunchAgent n’est pas installé, activez‑le depuis l’application ou exécutez
`openclaw gateway install`.

## Capacités du nœud (mac)

L’application macOS se présente comme un nœud. Commandes courantes :

- Canvas : `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Camera : `camera.snap`, `camera.clip`
- Screen : `screen.record`
- System : `system.run`, `system.notify`

Le nœud rapporte une carte `permissions` afin que les agents puissent décider de ce qui est autorisé.

Service de nœud + IPC de l’application :

- Lorsque le service hôte de nœud sans interface est en cours d’exécution (mode remote), il se connecte au WS de la Gateway en tant que nœud.
- `system.run` s’exécute dans l’application macOS (contexte UI/TCC) via un socket Unix local ; les invites et les sorties restent dans l’application.

Diagramme (SCI) :

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## Approbations d’exécution (system.run)

`system.run` est contrôlé par les **approbations d’exécution** dans l’application macOS (Réglages → Approbations d’exécution).
La sécurité + les demandes + la liste d’autorisation sont stockées localement sur le Mac dans :

```
~/.openclaw/exec-approvals.json
```

Exemple :

```json
{
  "version": 1,
  "defaults": {
    "security": "deny",
    "ask": "on-miss"
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [{ "pattern": "/opt/homebrew/bin/rg" }]
    }
  }
}
```

Notes :

- Les entrées `allowlist` sont des motifs glob pour les chemins de binaires résolus.
- Choisir « Toujours autoriser » dans l’invite ajoute cette commande à la liste d’autorisation.
- Les surcharges d’environnement `system.run` sont filtrées (suppression de `PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`) puis fusionnées avec l’environnement de l’application.

## Liens profonds

L’application enregistre le schéma d’URL `openclaw://` pour les actions locales.

### `openclaw://agent`

Déclenche une requête `agent` de la Gateway.

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

Paramètres de requête :

- `message` (obligatoire)
- `sessionKey` (optionnel)
- `thinking` (optionnel)
- `deliver` / `to` / `channel` (optionnel)
- `timeoutSeconds` (optionnel)
- `key` (clé optionnelle de mode non supervisé)

Sécurité :

- Sans `key`, l’application demande une confirmation.
- Avec un `key` valide, l’exécution est non supervisée (destinée aux automatisations personnelles).

## Flux de prise en main (typique)

1. Installer et lancer **OpenClaw.app**.
2. Compléter la liste de vérification des autorisations (invites TCC).
3. Vérifier que le mode **Local** est actif et que la Gateway est en cours d’exécution.
4. Installer le CLI si vous souhaitez un accès via le terminal.

## Flux de build et de développement (natif)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (ou Xcode)
- Empaquetage de l’application : `scripts/package-mac-app.sh`

## Déboguer la connectivité de la Gateway (CLI macOS)

Utilisez le CLI de débogage pour exercer la même négociation WebSocket et la même logique
de découverte de la Gateway que l’application macOS, sans lancer l’application.

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

Options de connexion :

- `--url <ws://host:port>` : remplacer la configuration
- `--mode <local|remote>` : résoudre depuis la configuration (par défaut : config ou local)
- `--probe` : forcer une nouvelle sonde d’état
- `--timeout <ms>` : délai d’expiration de la requête (par défaut : `15000`)
- `--json` : sortie structurée pour la comparaison

Options de découverte :

- `--include-local` : inclure les passerelles qui seraient filtrées comme « locales »
- `--timeout <ms>` : fenêtre globale de découverte (par défaut : `2000`)
- `--json` : sortie structurée pour la comparaison

Astuce : comparez avec `openclaw gateway discover --json` pour voir si le pipeline de découverte de l’application macOS
(NWBrowser + repli DNS‑SD tailnet) diffère de la découverte basée sur `dns-sd` du CLI Node.

## Mécanique de connexion distante (tunnels SSH)

Lorsque l’application macOS s’exécute en mode **Remote**, elle ouvre un tunnel SSH afin que les composants
d’interface utilisateur locaux puissent communiquer avec une Gateway distante comme si elle était sur localhost.

### Tunnel de contrôle (port WebSocket de la Gateway)

- **Objectif :** contrôles d’état, statut, Web Chat, configuration et autres appels du plan de contrôle.
- **Port local :** le port de la Gateway (par défaut `18789`), toujours stable.
- **Port distant :** le même port de la Gateway sur l’hôte distant.
- **Comportement :** aucun port local aléatoire ; l’application réutilise un tunnel sain existant
  ou le redémarre si nécessaire.
- **Forme SSH :** `ssh -N -L <local>:127.0.0.1:<remote>` avec BatchMode +
  ExitOnForwardFailure + options de keepalive.
- **Rapport d’IP :** le tunnel SSH utilise le loopback, la Gateway verra donc l’IP du nœud comme `127.0.0.1`. Utilisez le transport **Direct (ws/wss)** si vous souhaitez que la véritable IP cliente apparaisse
  (voir [accès distant macOS](/platforms/mac/remote)).

Pour les étapes de configuration, voir [accès distant macOS](/platforms/mac/remote). Pour les détails
du protocole, voir [protocole de la Gateway](/gateway/protocol).

## Documentation associée

- [Runbook de la Gateway](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [Autorisations macOS](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
