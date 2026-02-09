---
summary: "Decouverte des nœuds et transports (Bonjour, Tailscale, SSH) pour trouver la passerelle"
read_when:
  - Implementation ou modification de la decouverte/publicite Bonjour
  - Ajustement des modes de connexion distante (direct vs SSH)
  - Conception de la decouverte des nœuds et de l'appairage pour les nœuds distants
title: "Decouverte et transports"
---

# Decouverte & transports

OpenClaw presente deux problemes distincts qui se ressemblent en surface :

1. **Controle a distance par l’operateur** : l’application macOS de barre de menus controle une passerelle qui s’execute ailleurs.
2. **Appairage des nœuds** : iOS/Android (et les futurs nœuds) trouvent une passerelle et s’appairent de maniere securisee.

L’objectif de conception est de conserver toute la decouverte/publicite reseau dans la **Gateway (passerelle) de nœud** (`openclaw gateway`) et de garder les clients (app mac, iOS) comme consommateurs.

## Termes

- **Gateway (passerelle)** : un unique processus de passerelle de longue duree qui possede l’etat (sessions, appairage, registre des nœuds) et execute les canaux. La plupart des configurations en utilisent une par hote ; des configurations multi‑passerelles isolees sont possibles.
- **Gateway WS (plan de controle)** : le point de terminaison WebSocket sur `127.0.0.1:18789` par defaut ; peut etre lie au LAN/tailnet via `gateway.bind`.
- **Transport WS direct** : un point de terminaison Gateway WS expose au LAN/tailnet (sans SSH).
- **Transport SSH (secours)** : controle a distance en transferant `127.0.0.1:18789` via SSH.
- **Pont TCP historique (obsolete/supprime)** : ancien transport de nœud (voir [Bridge protocol](/gateway/bridge-protocol)) ; n’est plus annonce pour la decouverte.

Details de protocole :

- [Gateway protocol](/gateway/protocol)
- [Bridge protocol (legacy)](/gateway/bridge-protocol)

## Pourquoi conserver a la fois le « direct » et SSH

- **WS direct** offre la meilleure experience utilisateur sur le meme reseau et au sein d’un tailnet :
  - decouverte automatique sur le LAN via Bonjour
  - jetons d’appairage + ACL detenus par la passerelle
  - aucun acces au shell requis ; la surface de protocole peut rester restreinte et auditable
- **SSH** reste le secours universel :
  - fonctionne partout ou vous avez un acces SSH (meme a travers des reseaux sans lien)
  - resiste aux problemes de multicast/mDNS
  - ne necessite aucun nouveau port entrant autre que SSH

## Entrees de decouverte (comment les clients apprennent ou se trouve la passerelle)

### 1. Bonjour / mDNS (LAN uniquement)

Bonjour est « best‑effort » et ne traverse pas les reseaux. Il est utilise uniquement pour la commodite « meme LAN ».

Orientation cible :

- La **passerelle** annonce son point de terminaison WS via Bonjour.
- Les clients parcourent et affichent une liste « choisir une passerelle », puis enregistrent le point de terminaison choisi.

Depannage et details des balises : [Bonjour](/gateway/bonjour).

#### Details de la balise de service

- Types de service :
  - `_openclaw-gw._tcp` (balise de transport de la passerelle)
- Cles TXT (non secretes) :
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (ou ce qui est annonce)
  - `gatewayPort=18789` (Gateway WS + HTTP)
  - `gatewayTls=1` (uniquement lorsque TLS est active)
  - `gatewayTlsSha256=<sha256>` (uniquement lorsque TLS est active et que l’empreinte est disponible)
  - `canvasPort=18793` (port d’hote du canvas par defaut ; sert `/__openclaw__/canvas/`)
  - `cliPath=<path>` (optionnel ; chemin absolu vers un point d’entree `openclaw` executable ou un binaire)
  - `tailnetDns=<magicdns>` (indice optionnel ; detecte automatiquement lorsque Tailscale est disponible)

Desactiver/remplacer :

- `OPENCLAW_DISABLE_BONJOUR=1` desactive l’annonce.
- `gateway.bind` dans `~/.openclaw/openclaw.json` controle le mode de liaison de la Gateway (passerelle).
- `OPENCLAW_SSH_PORT` remplace le port SSH annonce dans le TXT (par defaut : 22).
- `OPENCLAW_TAILNET_DNS` publie un indice `tailnetDns` (MagicDNS).
- `OPENCLAW_CLI_PATH` remplace le chemin CLI annonce.

### 2. Tailnet (inter‑reseaux)

Pour des configurations de type Londres/Vienne, Bonjour ne sera d’aucune aide. La cible « directe » recommandee est :

- le nom MagicDNS Tailscale (prefere) ou une IP tailnet stable.

Si la passerelle peut detecter qu’elle s’execute sous Tailscale, elle publie `tailnetDns` comme indice optionnel pour les clients (y compris les balises a grande echelle).

### 3. Cible manuelle / SSH

Lorsqu’il n’existe aucune route directe (ou que le direct est desactive), les clients peuvent toujours se connecter via SSH en transferant le port de passerelle en loopback.

Voir [Remote access](/gateway/remote).

## Selection du transport (politique client)

Comportement client recommande :

1. Si un point de terminaison direct appaire est configure et accessible, l’utiliser.
2. Sinon, si Bonjour trouve une passerelle sur le LAN, proposer un choix « Utiliser cette passerelle » en un tap et l’enregistrer comme point de terminaison direct.
3. Sinon, si un DNS/IP tailnet est configure, tenter le direct.
4. Sinon, revenir a SSH.

## Appairage + auth (transport direct)

La passerelle est la source de verite pour l’admission des nœuds/clients.

- Les demandes d’appairage sont creees/approuvees/refusees dans la passerelle (voir [Gateway pairing](/gateway/pairing)).
- La passerelle applique :
  - l’auth (jeton / paire de cles)
  - les portees/ACL (la passerelle n’est pas un proxy brut vers chaque methode)
  - les limites de debit

## Responsabilites par composant

- **Gateway (passerelle)** : annonce les balises de decouverte, possede les decisions d’appairage et heberge le point de terminaison WS.
- **Application macOS** : vous aide a choisir une passerelle, affiche les invites d’appairage et n’utilise SSH qu’en secours.
- **Nœuds iOS/Android** : parcourent Bonjour par commodite et se connectent au Gateway WS appaire.
