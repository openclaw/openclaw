---
summary: "Flux de l’application macOS pour contrôler une Gateway OpenClaw distante via SSH"
read_when:
  - Configuration ou debogage du controle mac a distance
title: "Controle a distance"
---

# OpenClaw distant (macOS ⇄ hote distant)

Ce flux permet a l’application macOS d’agir comme une telecommande complete pour une Gateway (passerelle) OpenClaw executée sur un autre hote (poste de travail/serveur). Il s’agit de la fonctionnalite de l’application **Remote over SSH** (execution a distance). Toutes les fonctionnalites — controles de sante, transfert de Voice Wake et Web Chat — reutilisent la meme configuration SSH distante depuis _Settings → General_.

## Modes

- **Local (ce Mac)** : Tout s’execute sur l’ordinateur portable. Aucun SSH.
- **Remote over SSH (par defaut)** : Les commandes OpenClaw sont executees sur l’hote distant. L’application mac ouvre une connexion SSH avec `-o BatchMode` plus l’identite/cle choisie et un transfert de port local.
- **Remote direct (ws/wss)** : Aucun tunnel SSH. L’application mac se connecte directement a l’URL de la Gateway (passerelle) (par exemple via Tailscale Serve ou un reverse proxy HTTPS public).

## Transports distants

Le mode distant prend en charge deux transports :

- **Tunnel SSH** (par defaut) : Utilise `ssh -N -L ...` pour transferer le port de la Gateway (passerelle) vers localhost. La Gateway (passerelle) verra l’IP du nœud comme `127.0.0.1` car le tunnel est en loopback.
- **Direct (ws/wss)** : Se connecte directement a l’URL de la Gateway (passerelle). La Gateway (passerelle) voit l’IP reelle du client.

## Pré-qs sur l'hôte distant

1. Installer Node + pnpm et compiler/installer la CLI OpenClaw (`pnpm install && pnpm build && pnpm link --global`).
2. S’assurer que `openclaw` est sur le PATH pour les shells non interactifs (creer un lien symbolique dans `/usr/local/bin` ou `/opt/homebrew/bin` si necessaire).
3. Ouvrir SSH avec authentification par cle. Nous recommandons des IP **Tailscale** pour une accessibilite stable hors LAN.

## Configuration de l’application macOS

1. Ouvrez _Settings → General_.
2. Sous **OpenClaw runs**, choisissez **Remote over SSH** et configurez :
   - **Transport** : **SSH tunnel** ou **Direct (ws/wss)**.
   - **SSH target** : `user@host` (optionnel `:port`).
     - Si la Gateway (passerelle) est sur le meme LAN et annonce Bonjour, choisissez-la dans la liste decouverte pour remplir automatiquement ce champ.
   - **Gateway URL** (Direct uniquement) : `wss://gateway.example.ts.net` (ou `ws://...` pour local/LAN).
   - **Identity file** (avance) : chemin vers votre cle.
   - **Project root** (avance) : chemin du depot distant utilise pour les commandes.
   - **CLI path** (avance) : chemin optionnel vers un point d’entree/binaire `openclaw` executable (renseigne automatiquement lorsqu’annonce).
3. Cliquez sur **Test remote**. Un succes indique que le `openclaw status --json` distant s’execute correctement. Les echecs indiquent generalement des problemes de PATH/CLI ; un code de sortie 127 signifie que la CLI n’est pas trouvee a distance.
4. Les controles de sante et Web Chat fonctionneront maintenant automatiquement via ce tunnel SSH.

## Web Chat

- **Tunnel SSH** : Web Chat se connecte a la Gateway (passerelle) via le port de controle WebSocket transfere (par defaut 18789).
- **Direct (ws/wss)** : Web Chat se connecte directement a l’URL de la Gateway (passerelle) configuree.
- Il n’y a plus de serveur HTTP WebChat separe.

## Autorisations

- L’hote distant a besoin des memes validations TCC que le local (Automation, Accessibility, Screen Recording, Microphone, Speech Recognition, Notifications). Lancez la prise en main sur cette machine pour les accorder une fois.
- Les nœuds annoncent leur etat d’autorisations via `node.list` / `node.describe` afin que les agents sachent ce qui est disponible.

## Notes de securite

- Preferez des liaisons en loopback sur l’hote distant et connectez-vous via SSH ou Tailscale.
- Si vous liez la Gateway (passerelle) a une interface non loopback, exigez une authentification par jeton/mot de passe.
- Voir [Security](/gateway/security) et [Tailscale](/gateway/tailscale).

## Flux de connexion WhatsApp (distant)

- Executez `openclaw channels login --verbose` **sur l’hote distant**. Scannez le QR avec WhatsApp sur votre telephone.
- Relancez la connexion sur cet hote si l’authentification expire. Le controle de sante signalera les problemes de lien.

## Problemes courants

- **exit 127 / introuvable** : `openclaw` n’est pas sur le PATH pour les shells non connectes. Ajoutez-le a `/etc/paths`, a votre rc de shell, ou creez un lien symbolique dans `/usr/local/bin`/`/opt/homebrew/bin`.
- **Echec de la sonde de sante** : verifiez l’accessibilite SSH, le PATH, et que Baileys est connecte (`openclaw status --json`).
- **Web Chat bloque** : confirmez que la Gateway (passerelle) s’execute sur l’hote distant et que le port transfere correspond au port WS de la Gateway (passerelle) ; l’interface necessite une connexion WS saine.
- **L’IP du nœud affiche 127.0.0.1** : comportement attendu avec le tunnel SSH. Passez **Transport** a **Direct (ws/wss)** si vous souhaitez que la Gateway (passerelle) voie l’IP reelle du client.
- **Voice Wake** : les phrases de declenchement sont transferees automatiquement en mode distant ; aucun redirecteur separe n’est necessaire.

## Sons de notification

Choisissez des sons par notification depuis des scripts avec `openclaw` et `node.invoke`, par exemple :

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

Il n’y a plus de bascule « son par defaut » globale dans l’application ; les appelants choisissent un son (ou aucun) par requete.
