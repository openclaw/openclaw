---
summary: "Découverte Bonjour/mDNS + débogage (Balises Passerelle, clients et modes d'échec courants)"
read_when:
  - Débogage de problèmes de découverte Bonjour sur macOS/iOS
  - Modification de types de service mDNS, enregistrements TXT ou UX de découverte
title: "Découverte Bonjour"
---

# Découverte Bonjour / mDNS

OpenClaw utilise Bonjour (mDNS / DNS‑SD) comme **commodité LAN uniquement** pour découvrir une Passerelle active (point de terminaison WebSocket). C'est best-effort et ne **remplace pas** SSH ou la connectivité basée Tailnet.

## Bonjour à grande échelle (DNS‑SD Unicast) via Tailscale

Si le nœud et la passerelle sont sur des réseaux différents, le mDNS multicast ne traversera pas la frontière. Vous pouvez garder la même UX de découverte en basculant vers **DNS‑SD unicast** ("Bonjour à grande échelle") via Tailscale.

Étapes de haut niveau :

1. Exécutez un serveur DNS sur l'hôte passerelle (accessible via Tailnet).
2. Publiez les enregistrements DNS‑SD pour `_openclaw-gw._tcp` sous une zone dédiée (exemple : `openclaw.internal.`).
3. Configurez le **DNS fractionné** Tailscale pour que votre domaine choisi se résolve via ce serveur DNS pour les clients (incluant iOS).

OpenClaw supporte tout domaine de découverte ; `openclaw.internal.` est juste un exemple. Les nœuds iOS/Android parcourent à la fois `local.` et votre domaine grande échelle configuré.

### Config Passerelle (recommandé)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-uniquement (recommandé)
  discovery: { wideArea: { enabled: true } }, // active la publication DNS-SD grande échelle
}
```

### Configuration serveur DNS unique (hôte passerelle)

```bash
openclaw dns setup --apply
```

Cela installe CoreDNS et le configure pour :

- écouter sur le port 53 uniquement sur les interfaces Tailscale de la passerelle
- servir votre domaine choisi (exemple : `openclaw.internal.`) depuis `~/.openclaw/dns/<domain>.db`

Validez depuis une machine connectée tailnet :

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Paramètres DNS Tailscale

Dans la console admin Tailscale :

- Ajoutez un nameserver pointant vers l'IP tailnet de la passerelle (UDP/TCP 53).
- Ajoutez le DNS fractionné pour que votre domaine de découverte utilise ce nameserver.

Une fois que les clients acceptent le DNS tailnet, les nœuds iOS peuvent parcourir `_openclaw-gw._tcp` dans votre domaine de découverte sans multicast.

### Sécurité de l'écouteur Passerelle (recommandé)

Le port WS Passerelle (défaut `18789`) se lie à loopback par défaut. Pour l'accès LAN/tailnet, liez explicitement et gardez l'auth activée.

Pour les configurations tailnet-uniquement :

- Définissez `gateway.bind: "tailnet"` dans `~/.openclaw/openclaw.json`.
- Redémarrez la Passerelle (ou redémarrez l'app menubar macOS).

## Ce qui annonce

Seule la Passerelle annonce `_openclaw-gw._tcp`.

## Types de service

- `_openclaw-gw._tcp` — balise de transport passerelle (utilisée par les nœuds macOS/iOS/Android).

## Clés TXT (indices non-secrets)

La Passerelle annonce de petits indices non-secrets pour rendre les flux UI pratiques :

- `role=gateway`
- `displayName=<nom convivial>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (WS Passerelle + HTTP)
- `gatewayTls=1` (uniquement quand TLS est activé)
- `gatewayTlsSha256=<sha256>` (uniquement quand TLS est activé et l'empreinte est disponible)
- `canvasPort=<port>` (uniquement quand l'hôte canvas est activé ; actuellement le même que `gatewayPort`)
- `sshPort=<port>` (défaut 22 quand non remplacé)
- `transport=gateway`
- `cliPath=<path>` (optionnel ; chemin absolu vers un point d'entrée `openclaw` exécutable)
- `tailnetDns=<magicdns>` (indice optionnel quand Tailnet est disponible)

Notes de sécurité :

- Les enregistrements TXT Bonjour/mDNS sont **non authentifiés**. Les clients ne doivent pas traiter TXT comme routage autoritaire.
- Les clients devraient router en utilisant le point de terminaison de service résolu (SRV + A/AAAA). Traitez `lanHost`, `tailnetDns`, `gatewayPort` et `gatewayTlsSha256` comme indices uniquement.
- L'épinglage TLS ne doit jamais permettre à un `gatewayTlsSha256` annoncé de remplacer une épingle précédemment stockée.
- Les nœuds iOS/Android devraient traiter les connexions directes basées découverte comme **TLS-uniquement** et exiger une confirmation utilisateur explicite avant de faire confiance à une empreinte première fois.

## Débogage sur macOS

Outils intégrés utiles :

- Parcourir les instances :

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- Résoudre une instance (remplacez `<instance>`) :

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

Si le parcours fonctionne mais la résolution échoue, vous rencontrez généralement une politique LAN ou un problème de résolveur mDNS.

## Débogage dans les journaux Passerelle

La Passerelle écrit un fichier de log rotatif (imprimé au démarrage comme `gateway log file: ...`). Cherchez les lignes `bonjour:`, spécialement :

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## Débogage sur nœud iOS

Le nœud iOS utilise `NWBrowser` pour découvrir `_openclaw-gw._tcp`.

Pour capturer les journaux :

- Paramètres → Passerelle → Avancé → **Discovery Debug Logs**
- Paramètres → Passerelle → Avancé → **Discovery Logs** → reproduire → **Copier**

Le journal inclut les transitions d'état du navigateur et les changements d'ensemble de résultats.

## Modes d'échec courants

- **Bonjour ne traverse pas les réseaux** : utilisez Tailnet ou SSH.
- **Multicast bloqué** : certains réseaux Wi‑Fi désactivent mDNS.
- **Sommeil / agitation d'interface** : macOS peut temporairement supprimer les résultats mDNS ; réessayez.
- **Le parcours fonctionne mais la résolution échoue** : gardez les noms de machine simples (évitez les emojis ou ponctuation), puis redémarrez la Passerelle. Le nom d'instance de service dérive du nom d'hôte, donc les noms trop complexes peuvent confondre certains résolveurs.

## Noms d'instance échappés (`\032`)

Bonjour/DNS‑SD échappe souvent les octets dans les noms d'instance de service comme séquences décimales `\DDD` (par ex. les espaces deviennent `\032`).

- C'est normal au niveau protocole.
- Les UI devraient décoder pour l'affichage (iOS utilise `BonjourEscapes.decode`).

## Désactivation / configuration

- `OPENCLAW_DISABLE_BONJOUR=1` désactive la publicité (hérité : `OPENCLAW_DISABLE_BONJOUR`).
- `gateway.bind` dans `~/.openclaw/openclaw.json` contrôle le mode de liaison Passerelle.
- `OPENCLAW_SSH_PORT` remplace le port SSH annoncé dans TXT (hérité : `OPENCLAW_SSH_PORT`).
- `OPENCLAW_TAILNET_DNS` publie un indice MagicDNS dans TXT (hérité : `OPENCLAW_TAILNET_DNS`).
- `OPENCLAW_CLI_PATH` remplace le chemin CLI annoncé (hérité : `OPENCLAW_CLI_PATH`).

## Docs liées

- Politique de découverte et sélection de transport : [Découverte](/fr-FR/gateway/discovery)
- Appairage de nœud + approbations : [Appairage passerelle](/fr-FR/gateway/pairing)
