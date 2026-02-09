---
summary: "Découverte Bonjour/mDNS + débogage (balises de la Gateway (passerelle), clients et modes de défaillance courants)"
read_when:
  - Débogage des problèmes de découverte Bonjour sur macOS/iOS
  - Modification des types de services mDNS, des enregistrements TXT ou de l’UX de découverte
title: "Découverte Bonjour"
---

# Découverte Bonjour / mDNS

OpenClaw utilise Bonjour (mDNS / DNS‑SD) comme une **commodité limitée au LAN** pour découvrir
une Gateway (passerelle) active (point de terminaison WebSocket). C’est du best‑effort et cela **ne** remplace **pas** SSH ni la connectivité basée sur Tailnet.

## Bonjour étendu (DNS‑SD unicast) via Tailscale

Si le nœud et la Gateway (passerelle) sont sur des réseaux différents, le mDNS multicast ne franchit pas la
frontière. Vous pouvez conserver la même UX de découverte en passant au **DNS‑SD unicast**
(« Bonjour étendu ») via Tailscale.

Étapes de haut niveau :

1. Exécuter un serveur DNS sur l’hôte de la gateway (accessible via Tailnet).
2. Publier des enregistrements DNS‑SD pour `_openclaw-gw._tcp` sous une zone dédiée
   (exemple : `openclaw.internal.`).
3. Configurer le **split DNS** de Tailscale afin que votre domaine choisi se résolve via ce
   serveur DNS pour les clients (y compris iOS).

OpenClaw prend en charge n’importe quel domaine de découverte ; `openclaw.internal.` n’est qu’un exemple.
Les nœuds iOS/Android parcourent à la fois `local.` et votre domaine étendu configuré.

### Configuration de la Gateway (passerelle) (recommandée)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### Configuration unique du serveur DNS (hôte de la gateway)

```bash
openclaw dns setup --apply
```

Cela installe CoreDNS et le configure pour :

- écouter sur le port 53 uniquement sur les interfaces Tailscale de la gateway
- servir votre domaine choisi (exemple : `openclaw.internal.`) depuis `~/.openclaw/dns/<domain>.db`

Validez depuis une machine connectée au tailnet :

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Paramètres DNS de Tailscale

Dans la console d’administration Tailscale :

- Ajoutez un serveur de noms pointant vers l’IP tailnet de la gateway (UDP/TCP 53).
- Ajoutez un split DNS afin que votre domaine de découverte utilise ce serveur de noms.

Une fois que les clients acceptent le DNS du tailnet, les nœuds iOS peuvent parcourir
`_openclaw-gw._tcp` dans votre domaine de découverte sans multicast.

### Sécurité de l’écoute de la Gateway (passerelle) (recommandée)

Le port WS de la Gateway (par défaut `18789`) se lie à la loopback par défaut. Pour l’accès LAN/tailnet,
liez‑le explicitement et conservez l’authentification activée.

Pour des configurations tailnet‑uniquement :

- Définissez `gateway.bind: "tailnet"` dans `~/.openclaw/openclaw.json`.
- Redémarrez la Gateway (ou redémarrez l’app de la barre de menus macOS).

## Ce qui annonce

Seule la Gateway (passerelle) annonce `_openclaw-gw._tcp`.

## Types de services

- `_openclaw-gw._tcp` — balise de transport de la gateway (utilisée par les nœuds macOS/iOS/Android).

## Clés TXT (indices non secrets)

La Gateway (passerelle) annonce de petits indices non secrets pour faciliter les flux UI :

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (uniquement lorsque TLS est activé)
- `gatewayTlsSha256=<sha256>` (uniquement lorsque TLS est activé et que l’empreinte est disponible)
- `canvasPort=<port>` (uniquement lorsque l’hôte canvas est activé ; valeur par défaut `18793`)
- `sshPort=<port>` (valeur par défaut 22 lorsqu’elle n’est pas remplacée)
- `transport=gateway`
- `cliPath=<path>` (optionnel ; chemin absolu vers un point d’entrée `openclaw` exécutable)
- `tailnetDns=<magicdns>` (indice optionnel lorsque Tailnet est disponible)

## Débogage sur macOS

Outils intégrés utiles :

- Parcourir les instances :

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- Résoudre une instance (remplacez `<instance>`) :

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

Si le parcours fonctionne mais que la résolution échoue, vous rencontrez généralement une politique LAN ou
un problème de résolveur mDNS.

## Débogage dans les journaux de la Gateway (passerelle)

La Gateway écrit un fichier journal tournant (affiché au démarrage sous
`gateway log file: ...`). Recherchez les lignes `bonjour:`, en particulier :

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## Débogage sur le nœud iOS

Le nœud iOS utilise `NWBrowser` pour découvrir `_openclaw-gw._tcp`.

Pour capturer les journaux :

- Réglages → Gateway → Avancé → **Journaux de débogage de la découverte**
- Réglages → Gateway → Avancé → **Journaux de découverte** → reproduire → **Copier**

Le journal inclut les transitions d’état du navigateur et les changements d’ensembles de résultats.

## Modes de défaillance courants

- **Bonjour ne traverse pas les réseaux** : utilisez Tailnet ou SSH.
- **Multicast bloqué** : certains réseaux Wi‑Fi désactivent mDNS.
- **Veille / changements d’interface** : macOS peut temporairement perdre des résultats mDNS ; réessayez.
- **Le parcours fonctionne mais la résolution échoue** : conservez des noms de machine simples (évitez les émojis ou
  la ponctuation), puis redémarrez la Gateway. Le nom d’instance du service dérive du
  nom d’hôte ; des noms trop complexes peuvent perturber certains résolveurs.

## Noms d’instance échappés (`\032`)

Bonjour/DNS‑SD échappe souvent des octets dans les noms d’instance de service sous forme de séquences décimales
`\DDD` (par exemple, les espaces deviennent `\032`).

- C’est normal au niveau du protocole.
- Les interfaces utilisateur doivent décoder pour l’affichage (iOS utilise `BonjourEscapes.decode`).

## Désactivation / configuration

- `OPENCLAW_DISABLE_BONJOUR=1` désactive l’annonce (héritage : `OPENCLAW_DISABLE_BONJOUR`).
- `gateway.bind` dans `~/.openclaw/openclaw.json` contrôle le mode de liaison de la Gateway.
- `OPENCLAW_SSH_PORT` remplace le port SSH annoncé dans TXT (héritage : `OPENCLAW_SSH_PORT`).
- `OPENCLAW_TAILNET_DNS` publie un indice MagicDNS dans TXT (héritage : `OPENCLAW_TAILNET_DNS`).
- `OPENCLAW_CLI_PATH` remplace le chemin CLI annoncé (héritage : `OPENCLAW_CLI_PATH`).

## Documentation associée

- Politique de découverte et sélection du transport : [Discovery](/gateway/discovery)
- Appairage des nœuds + approbations : [Gateway pairing](/gateway/pairing)
