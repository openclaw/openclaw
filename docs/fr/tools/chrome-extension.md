---
summary: "Extension Chrome : laissez OpenClaw piloter votre onglet Chrome existant"
read_when:
  - Vous souhaitez que l’agent pilote un onglet Chrome existant (bouton de la barre d’outils)
  - Vous avez besoin d’un Gateway distant + d’une automatisation locale du navigateur via Tailscale
  - Vous voulez comprendre les implications de sécurité de la prise de contrôle du navigateur
title: "Extension Chrome"
---

# Extension Chrome (relais du navigateur)

L’extension Chrome OpenClaw permet à l’agent de contrôler vos **onglets Chrome existants** (votre fenêtre Chrome habituelle) au lieu de lancer un profil Chrome distinct géré par openclaw.

L’attachement/le détachement se fait via **un seul bouton de la barre d’outils Chrome**.

## Ce que c’est (concept)

Il y a trois composants :

- **Service de contrôle du navigateur** (Gateway ou nœud) : l’API que l’agent/l’outil appelle (via le Gateway)
- **Serveur de relais local** (CDP en local loopback) : fait le pont entre le serveur de contrôle et l’extension (`http://127.0.0.1:18792` par défaut)
- **Extension Chrome MV3** : s’attache à l’onglet actif à l’aide de `chrome.debugger` et achemine les messages CDP vers le relais

OpenClaw contrôle ensuite l’onglet attaché via la surface d’outil `browser` habituelle (en sélectionnant le bon profil).

## Installer / charger (non empaqueté)

1. Installez l’extension dans un chemin local stable :

```bash
openclaw browser extension install
```

2. Affichez le chemin du répertoire de l’extension installée :

```bash
openclaw browser extension path
```

3. Chrome → `chrome://extensions`

- Activez « Mode développeur »
- « Charger l’extension non empaquetée » → sélectionnez le répertoire affiché ci-dessus

4. Épinglez l’extension.

## Mises à jour (sans étape de build)

L’extension est fournie dans la version OpenClaw (package npm) sous forme de fichiers statiques. Il n’y a pas d’étape de « build » séparée.

Après la mise à niveau d’OpenClaw :

- Relancez `openclaw browser extension install` pour actualiser les fichiers installés sous votre répertoire d’état OpenClaw.
- Chrome → `chrome://extensions` → cliquez sur « Recharger » pour l’extension.

## L’utiliser (sans configuration supplémentaire)

OpenClaw fournit un profil de navigateur intégré nommé `chrome` qui cible le relais de l’extension sur le port par défaut.

Utilisation :

- CLI : `openclaw browser --browser-profile chrome tabs`
- Outil d’agent : `browser` avec `profile="chrome"`

Si vous souhaitez un autre nom ou un autre port de relais, créez votre propre profil :

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## Attacher / détacher (bouton de la barre d’outils)

- Ouvrez l’onglet que vous voulez faire contrôler par OpenClaw.
- Cliquez sur l’icône de l’extension.
  - Le badge affiche `ON` lorsqu’il est attaché.
- Cliquez à nouveau pour détacher.

## Quel onglet est contrôlé ?

- Il ne contrôle **pas** automatiquement « l’onglet que vous regardez ».
- Il contrôle **uniquement l’/les onglet(s) que vous avez explicitement attaché(s)** en cliquant sur le bouton de la barre d’outils.
- Pour changer : ouvrez l’autre onglet et cliquez sur l’icône de l’extension dans cet onglet.

## Badge + erreurs courantes

- `ON` : attaché ; OpenClaw peut piloter cet onglet.
- `…` : connexion au relais local.
- `!` : relais injoignable (le plus courant : le serveur de relais du navigateur n’est pas en cours d’exécution sur cette machine).

Si vous voyez `!` :

- Assurez-vous que le Gateway s’exécute localement (configuration par défaut), ou lancez un hôte de nœud sur cette machine si le Gateway s’exécute ailleurs.
- Ouvrez la page Options de l’extension ; elle indique si le relais est joignable.

## Gateway distant (utiliser un hôte de nœud)

### Gateway local (même machine que Chrome) — généralement **aucune étape supplémentaire**

Si le Gateway s’exécute sur la même machine que Chrome, il démarre le service de contrôle du navigateur en local loopback
et lance automatiquement le serveur de relais. L’extension communique avec le relais local ; les appels CLI/outil vont vers le Gateway.

### Gateway distant (le Gateway s’exécute ailleurs) — **exécuter un hôte de nœud**

Si votre Gateway s’exécute sur une autre machine, démarrez un hôte de nœud sur la machine qui exécute Chrome.
Le Gateway proxifiera les actions du navigateur vers ce nœud ; l’extension + le relais restent locaux à la machine du navigateur.

Si plusieurs nœuds sont connectés, épinglez-en un avec `gateway.nodes.browser.node` ou définissez `gateway.nodes.browser.mode`.

## Sandboxing (conteneurs d’outils)

Si votre session d’agent est en sandbox (`agents.defaults.sandbox.mode != "off"`), l’outil `browser` peut être restreint :

- Par défaut, les sessions en sandbox ciblent souvent le **navigateur sandbox** (`target="sandbox"`), et non votre Chrome hôte.
- La prise de contrôle via le relais de l’extension Chrome nécessite de contrôler le serveur de contrôle du navigateur **hôte**.

Options :

- Le plus simple : utiliser l’extension depuis une session/un agent **non en sandbox**.
- Ou autoriser le contrôle du navigateur hôte pour les sessions en sandbox :

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Assurez-vous ensuite que l’outil n’est pas refusé par la politique d’outils et (si nécessaire) appelez `browser` avec `target="host"`.

Débogage : `openclaw sandbox explain`

## Conseils d’accès distant

- Conservez le Gateway et l’hôte de nœud sur le même tailnet ; évitez d’exposer les ports du relais au LAN ou à l’Internet public.
- Appariez les nœuds intentionnellement ; désactivez le routage proxy du navigateur si vous ne souhaitez pas de contrôle à distance (`gateway.nodes.browser.mode="off"`).

## Fonctionnement du « chemin de l’extension »

`openclaw browser extension path` affiche le répertoire **installé** sur disque contenant les fichiers de l’extension.

La CLI n’affiche intentionnellement **pas** un chemin `node_modules`. Exécutez toujours `openclaw browser extension install` en premier pour copier l’extension vers un emplacement stable sous votre répertoire d’état OpenClaw.

Si vous déplacez ou supprimez ce répertoire d’installation, Chrome marquera l’extension comme défectueuse jusqu’à ce que vous la rechargiez depuis un chemin valide.

## Implications de sécurité (à lire)

C’est puissant et risqué. Traitez cela comme si vous donniez au modèle « les mains sur votre navigateur ».

- L’extension utilise l’API de débogage de Chrome (`chrome.debugger`). Lorsqu’elle est attachée, le modèle peut :
  - cliquer/taper/naviguer dans cet onglet
  - lire le contenu de la page
  - accéder à tout ce à quoi la session connectée de l’onglet peut accéder
- **Ce n’est pas isolé** comme le profil dédié géré par openclaw.
  - Si vous vous attachez à votre profil/onglet de navigation quotidien, vous accordez l’accès à l’état de ce compte.

Recommandations :

- Préférez un profil Chrome dédié (séparé de votre navigation personnelle) pour l’utilisation du relais d’extension.
- Conservez le Gateway et les hôtes de nœud en accès tailnet uniquement ; fiez-vous à l’authentification du Gateway + à l’appariement des nœuds.
- Évitez d’exposer les ports du relais sur le LAN (`0.0.0.0`) et évitez Funnel (public).
- Le relais bloque les origines non liées à l’extension et exige un jeton d’authentification interne pour les clients CDP.

Liens associés :

- Vue d’ensemble de l’outil Navigateur : [Browser](/tools/browser)
- Audit de sécurité : [Security](/gateway/security)
- Configuration Tailscale : [Tailscale](/gateway/tailscale)
