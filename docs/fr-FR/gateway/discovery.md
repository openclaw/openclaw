---
summary: "Découverte de nœud et transports (Bonjour, Tailscale, SSH) pour trouver la passerelle"
read_when:
  - Implémentation ou modification de la découverte/publicité Bonjour
  - Ajustement des modes de connexion distante (direct vs SSH)
  - Conception de découverte de nœud + appairage pour nœuds distants
title: "Découverte et transports"
---

# Découverte & transports

OpenClaw a deux problèmes distincts qui semblent similaires en surface :

1. **Contrôle distant opérateur** : l'app barre de menu macOS contrôlant une passerelle s'exécutant ailleurs.
2. **Appairage de nœud** : iOS/Android (et nœuds futurs) trouvant une passerelle et s'appariant en sécurité.

L'objectif de conception est de garder toute la découverte/publicité réseau dans la **Passerelle de nœud** (`openclaw gateway`) et de garder les clients (app mac, iOS) comme consommateurs.

## Termes

- **Passerelle** : un processus passerelle unique de longue durée qui possède l'état (sessions, appairage, registre de nœud) et exécute les canaux. La plupart des configurations utilisent une par hôte ; les configurations multi-passerelle isolées sont possibles.
- **WS Passerelle (plan de contrôle)** : le point de terminaison WebSocket sur `127.0.0.1:18789` par défaut ; peut être lié au LAN/tailnet via `gateway.bind`.
- **Transport WS direct** : un point de terminaison WS Passerelle orienté LAN/tailnet (pas de SSH).
- **Transport SSH (fallback)** : contrôle distant en transférant `127.0.0.1:18789` via SSH.
- **Bridge TCP hérité (déprécié/supprimé)** : ancien transport nœud (voir [Protocole bridge](/fr-FR/gateway/bridge-protocol)) ; plus annoncé pour la découverte.

Détails de protocole :

- [Protocole passerelle](/fr-FR/gateway/protocol)
- [Protocole bridge (hérité)](/fr-FR/gateway/bridge-protocol)

## Pourquoi nous gardons à la fois "direct" et SSH

- **WS direct** est la meilleure UX sur le même réseau et au sein d'un tailnet :
  - auto-découverte sur LAN via Bonjour
  - tokens d'appairage + ACLs appartenant à la passerelle
  - pas d'accès shell requis ; la surface de protocole peut rester serrée et auditable
- **SSH** reste le fallback universel :
  - fonctionne partout où vous avez un accès SSH (même sur des réseaux non liés)
  - survit aux problèmes multicast/mDNS
  - ne nécessite aucun nouveau port entrant en plus de SSH

## Entrées de découverte (comment les clients apprennent où est la passerelle)

### 1) Bonjour / mDNS (LAN uniquement)

Bonjour est best-effort et ne traverse pas les réseaux. Il est uniquement utilisé pour la commodité "même LAN".

Direction cible :

- La **passerelle** annonce son point de terminaison WS via Bonjour.
- Les clients parcourent et affichent une liste "choisir une passerelle", puis stockent le point de terminaison choisi.

Dépannage et détails de balise : [Bonjour](/fr-FR/gateway/bonjour).

#### Détails de balise de service

- Types de service :
  - `_openclaw-gw._tcp` (balise de transport passerelle)
- Clés TXT (non-secret) :
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (ou ce qui est annoncé)
  - `gatewayPort=18789` (WS Passerelle + HTTP)
  - `gatewayTls=1` (uniquement quand TLS est activé)
  - `gatewayTlsSha256=<sha256>` (uniquement quand TLS est activé et l'empreinte est disponible)
  - `canvasPort=<port>` (port hôte canvas ; actuellement le même que `gatewayPort` quand l'hôte canvas est activé)
  - `cliPath=<path>` (optionnel ; chemin absolu vers un point d'entrée ou binaire `openclaw` exécutable)
  - `tailnetDns=<magicdns>` (indice optionnel ; auto-détecté quand Tailscale est disponible)

Notes de sécurité :

- Les enregistrements TXT Bonjour/mDNS sont **non authentifiés**. Les clients doivent traiter les valeurs TXT comme des indices UX uniquement.
- Le routage (hôte/port) devrait préférer le **point de terminaison de service résolu** (SRV + A/AAAA) sur `lanHost`, `tailnetDns` ou `gatewayPort` fourni par TXT.
- L'épinglage TLS ne doit jamais permettre à un `gatewayTlsSha256` annoncé de remplacer une épingle précédemment stockée.
- Les nœuds iOS/Android devraient traiter les connexions directes basées sur la découverte comme **TLS-uniquement** et nécessiter une confirmation explicite "faire confiance à cette empreinte" avant de stocker une épingle première fois (vérification hors bande).

Désactiver/remplacer :

- `OPENCLAW_DISABLE_BONJOUR=1` désactive la publicité.
- `gateway.bind` dans `~/.openclaw/openclaw.json` contrôle le mode de liaison Passerelle.
- `OPENCLAW_SSH_PORT` remplace le port SSH annoncé dans TXT (défaut 22).
- `OPENCLAW_TAILNET_DNS` publie un indice `tailnetDns` (MagicDNS).
- `OPENCLAW_CLI_PATH` remplace le chemin CLI annoncé.

### 2) Tailnet (cross-réseau)

Pour les configurations style Londres/Vienne, Bonjour n'aidera pas. La cible "directe" recommandée est :

- Nom MagicDNS Tailscale (préféré) ou une IP tailnet stable.

Si la passerelle peut détecter qu'elle s'exécute sous Tailscale, elle publie `tailnetDns` comme indice optionnel pour les clients (incluant les balises à grande échelle).

### 3) Cible manuelle / SSH

Lorsqu'il n'y a pas de route directe (ou le direct est désactivé), les clients peuvent toujours se connecter via SSH en transférant le port passerelle loopback.

Voir [Accès distant](/fr-FR/gateway/remote).

## Sélection de transport (politique client)

Comportement client recommandé :

1. Si un point de terminaison direct apparié est configuré et accessible, utilisez-le.
2. Sinon, si Bonjour trouve une passerelle sur LAN, offrez un choix "Utiliser cette passerelle" en un tap et sauvegardez-le comme point de terminaison direct.
3. Sinon, si un DNS/IP tailnet est configuré, essayez direct.
4. Sinon, revenez à SSH.

## Appairage + auth (transport direct)

La passerelle est la source de vérité pour l'admission nœud/client.

- Les demandes d'appairage sont créées/approuvées/rejetées dans la passerelle (voir [Appairage passerelle](/fr-FR/gateway/pairing)).
- La passerelle applique :
  - auth (token / paire de clés)
  - scopes/ACLs (la passerelle n'est pas un proxy brut vers chaque méthode)
  - limites de taux

## Responsabilités par composant

- **Passerelle** : annonce les balises de découverte, possède les décisions d'appairage et héberge le point de terminaison WS.
- **App macOS** : vous aide à choisir une passerelle, affiche les invites d'appairage et utilise SSH uniquement comme fallback.
- **Nœuds iOS/Android** : parcourent Bonjour comme commodité et se connectent au WS Passerelle apparié.
