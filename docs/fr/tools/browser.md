---
summary: "Service de contrôle de navigateur intégré + commandes d’action"
read_when:
  - Ajout d’une automatisation de navigateur contrôlée par un agent
  - Débogage des interférences d’openclaw avec votre propre Chrome
  - Implémentation des paramètres et du cycle de vie du navigateur dans l’application macOS
title: "Navigateur (géré par OpenClaw)"
---

# Navigateur (géré par openclaw)

OpenClaw peut exécuter un **profil Chrome/Brave/Edge/Chromium dédié** que l’agent contrôle.
Il est isolé de votre navigateur personnel et est géré via un petit service de contrôle local
à l’intérieur de la Gateway (passerelle) (loopback uniquement).

Vue débutant :

- Considérez-le comme un **navigateur séparé, réservé à l’agent**.
- Le profil `openclaw` **n’affecte pas** le profil de votre navigateur personnel.
- L’agent peut **ouvrir des onglets, lire des pages, cliquer et saisir du texte** dans un environnement sûr.
- Le profil `chrome` par défaut utilise le **navigateur Chromium par défaut du système** via le relais d’extension ; passez à `openclaw` pour le navigateur géré et isolé.

## Ce que vous obtenez

- Un profil de navigateur distinct nommé **openclaw** (accent orange par défaut).
- Un contrôle déterministe des onglets (lister/ouvrir/focaliser/fermer).
- Des actions de l’agent (cliquer/saisir/glisser/sélectionner), des instantanés, des captures d’écran, des PDF.
- Une prise en charge optionnelle de plusieurs profils (`openclaw`, `work`, `remote`, ...).

Ce navigateur **n’est pas** votre navigateur principal au quotidien. C’est une surface sûre et isolée pour
l’automatisation et la vérification par agent.

## Demarrage rapide

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

Si vous obtenez « Browser disabled », activez-le dans la configuration (voir ci-dessous) et redémarrez la
Gateway (passerelle).

## Profils : `openclaw` vs `chrome`

- `openclaw` : navigateur géré et isolé (aucune extension requise).
- `chrome` : relais d’extension vers votre **navigateur système** (nécessite que l’extension OpenClaw
  soit attachée à un onglet).

Définissez `browser.defaultProfile: "openclaw"` si vous souhaitez le mode géré par défaut.

## Configuration

Les paramètres du navigateur se trouvent dans `~/.openclaw/openclaw.json`.

```json5
{
  browser: {
    enabled: true, // default: true
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    remoteCdpTimeoutMs: 1500, // remote CDP HTTP timeout (ms)
    remoteCdpHandshakeTimeoutMs: 3000, // remote CDP WebSocket handshake timeout (ms)
    defaultProfile: "chrome",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
  },
}
```

Remarques :

- Le service de contrôle du navigateur se lie au loopback sur un port dérivé de `gateway.port`
  (par défaut : `18791`, soit la gateway + 2). Le relais utilise le port suivant (`18792`).
- Si vous redéfinissez le port de la Gateway (`gateway.port` ou `OPENCLAW_GATEWAY_PORT`),
  les ports dérivés du navigateur se décalent pour rester dans la même « famille ».
- `cdpUrl` utilise par défaut le port du relais lorsqu’il n’est pas défini.
- `remoteCdpTimeoutMs` s’applique aux vérifications d’accessibilité CDP distantes (non-loopback).
- `remoteCdpHandshakeTimeoutMs` s’applique aux vérifications d’accessibilité WebSocket CDP distantes.
- `attachOnly: true` signifie « ne jamais lancer un navigateur local ; uniquement s’y attacher s’il est déjà en cours d’exécution ».
- `color` + `color` par profil teintent l’interface du navigateur afin que vous puissiez voir quel profil est actif.
- Le profil par défaut est `chrome` (relais d’extension). Utilisez `defaultProfile: "openclaw"` pour le navigateur géré.
- Ordre d’auto-détection : navigateur système par défaut s’il est basé sur Chromium ; sinon Chrome → Brave → Edge → Chromium → Chrome Canary.
- Les profils locaux `openclaw` attribuent automatiquement `cdpPort`/`cdpUrl` — ne définissez ceux-ci que pour le CDP distant.

## Utiliser Brave (ou un autre navigateur basé sur Chromium)

Si votre navigateur **par défaut du système** est basé sur Chromium (Chrome/Brave/Edge/etc),
OpenClaw l’utilise automatiquement. Définissez `browser.executablePath` pour remplacer
l’auto-détection :

Exemple CLI :

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
```

```json5
// macOS
{
  browser: {
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  }
}

// Windows
{
  browser: {
    executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  }
}

// Linux
{
  browser: {
    executablePath: "/usr/bin/brave-browser"
  }
}
```

## Contrôle local vs distant

- **Contrôle local (par défaut)** : la Gateway (passerelle) démarre le service de contrôle loopback et peut lancer un navigateur local.
- **Contrôle distant (hôte de nœud)** : exécutez un hôte de nœud sur la machine qui dispose du navigateur ; la Gateway (passerelle) y proxifie les actions du navigateur.
- **CDP distant** : définissez `browser.profiles.<name>.cdpUrl` (ou `browser.cdpUrl`) pour
  vous attacher à un navigateur distant basé sur Chromium. Dans ce cas, OpenClaw ne lancera pas de navigateur local.

Les URL CDP distantes peuvent inclure une authentification :

- Jetons de requête (par ex., `https://provider.example?token=<token>`)
- Authentification HTTP Basic (par ex., `https://user:pass@provider.example`)

OpenClaw conserve l’authentification lors des appels aux points de terminaison `/json/*` et lors de la connexion
au WebSocket CDP. Préférez les variables d’environnement ou les gestionnaires de secrets pour les
jetons plutôt que de les valider dans les fichiers de configuration.

## Proxy de navigateur de nœud (par défaut sans configuration)

Si vous exécutez un **hôte de nœud** sur la machine qui dispose de votre navigateur, OpenClaw peut
acheminer automatiquement les appels d’outils du navigateur vers ce nœud sans configuration supplémentaire du navigateur.
C’est le chemin par défaut pour les gateways distantes.

Remarques :

- L’hôte de nœud expose son serveur local de contrôle du navigateur via une **commande proxy**.
- Les profils proviennent de la propre configuration `browser.profiles` du nœud (identique au local).
- Désactivez-le si vous ne le souhaitez pas :
  - Sur le nœud : `nodeHost.browserProxy.enabled=false`
  - Sur la gateway : `gateway.nodes.browser.mode="off"`

## Browserless (CDP distant hébergé)

[Browserless](https://browserless.io) est un service Chromium hébergé qui expose
des points de terminaison CDP via HTTPS. Vous pouvez diriger un profil de navigateur OpenClaw vers un
point de terminaison régional Browserless et vous authentifier avec votre clé API.

Exemple :

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    remoteCdpTimeoutMs: 2000,
    remoteCdpHandshakeTimeoutMs: 4000,
    profiles: {
      browserless: {
        cdpUrl: "https://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",
        color: "#00AA00",
      },
    },
  },
}
```

Remarques :

- Remplacez `<BROWSERLESS_API_KEY>` par votre véritable jeton Browserless.
- Choisissez le point de terminaison régional correspondant à votre compte Browserless (voir leur documentation).

## Sécurité

Idées clés :

- Le contrôle du navigateur est limité au loopback ; l’accès passe par l’authentification de la Gateway (passerelle) ou l’appairage de nœuds.
- Conservez la Gateway (passerelle) et tout hôte de nœud sur un réseau privé (Tailscale) ; évitez toute exposition publique.
- Traitez les URL/jetons CDP distants comme des secrets ; préférez les variables d’environnement ou un gestionnaire de secrets.

Conseils CDP distants :

- Préférez des points de terminaison HTTPS et des jetons à courte durée de vie lorsque c’est possible.
- Évitez d’intégrer des jetons de longue durée directement dans les fichiers de configuration.

## Profils (multi-navigateurs)

OpenClaw prend en charge plusieurs profils nommés (configurations de routage). Les profils peuvent être :

- **openclaw-managed** : une instance de navigateur basée sur Chromium dédiée avec son propre répertoire de données utilisateur + port CDP
- **remote** : une URL CDP explicite (navigateur basé sur Chromium exécuté ailleurs)
- **extension relay** : vos onglets Chrome existants via le relais local + extension Chrome

Valeurs par défaut :

- Le profil `openclaw` est créé automatiquement s’il est absent.
- Le profil `chrome` est intégré pour le relais d’extension Chrome (pointe vers `http://127.0.0.1:18792` par défaut).
- Les ports CDP locaux sont alloués à partir de **18800–18899** par défaut.
- La suppression d’un profil déplace son répertoire de données local vers la Corbeille.

Tous les points de terminaison de contrôle acceptent `?profile=<name>` ; la CLI utilise `--browser-profile`.

## Relais d’extension Chrome (utiliser votre Chrome existant)

OpenClaw peut également piloter **vos onglets Chrome existants** (sans instance Chrome « openclaw » séparée) via un relais CDP local + une extension Chrome.

Guide complet : [Extension Chrome](/tools/chrome-extension)

Flux :

- La Gateway (passerelle) s’exécute localement (même machine) ou un hôte de nœud s’exécute sur la machine du navigateur.
- Un **serveur relais** local écoute sur un loopback `cdpUrl` (par défaut : `http://127.0.0.1:18792`).
- Vous cliquez sur l’icône d’extension **OpenClaw Browser Relay** sur un onglet pour l’attacher (il ne s’attache pas automatiquement).
- L’agent contrôle cet onglet via l’outil `browser` habituel, en sélectionnant le bon profil.

Si la Gateway (passerelle) s’exécute ailleurs, exécutez un hôte de nœud sur la machine du navigateur afin que la Gateway (passerelle) puisse proxifier les actions du navigateur.

### Sessions en sandbox

Si la session de l’agent est en sandbox, l’outil `browser` peut par défaut utiliser `target="sandbox"` (navigateur sandbox).
La prise de contrôle via le relais d’extension Chrome nécessite le contrôle du navigateur hôte, donc soit :

- exécutez la session hors sandbox, ou
- définissez `agents.defaults.sandbox.browser.allowHostControl: true` et utilisez `target="host"` lors de l’appel de l’outil.

### Configuration

1. Charger l’extension (dev/non empaquetée) :

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → activer « Developer mode »
- « Load unpacked » → sélectionner le répertoire affiché par `openclaw browser extension path`
- Épinglez l’extension, puis cliquez dessus sur l’onglet que vous souhaitez contrôler (le badge affiche `ON`).

2. L’utiliser :

- CLI : `openclaw browser --browser-profile chrome tabs`
- Outil d’agent : `browser` avec `profile="chrome"`

Optionnel : si vous souhaitez un nom ou un port de relais différent, créez votre propre profil :

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

Remarques :

- Ce mode s’appuie sur Playwright-on-CDP pour la plupart des opérations (captures d’écran/instantanés/actions).
- Détachez en cliquant à nouveau sur l’icône de l’extension.

## Garanties d’isolation

- **Répertoire de données utilisateur dédié** : n’affecte jamais le profil de votre navigateur personnel.
- **Ports dédiés** : évite `9222` pour prévenir les collisions avec les flux de travail de développement.
- **Contrôle déterministe des onglets** : ciblez les onglets par `targetId`, pas par « dernier onglet ».

## Sélection du navigateur

Lors du lancement local, OpenClaw choisit le premier disponible :

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

Vous pouvez remplacer ce choix avec `browser.executablePath`.

Plateformes :

- macOS : vérifie `/Applications` et `~/Applications`.
- Linux : recherche `google-chrome`, `brave`, `microsoft-edge`, `chromium`, etc.
- Windows : vérifie les emplacements d’installation courants.

## API de contrôle (optionnelle)

Pour les intégrations locales uniquement, la Gateway (passerelle) expose une petite API HTTP loopback :

- Statut/démarrer/arrêter : `GET /`, `POST /start`, `POST /stop`
- Onglets : `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- Instantané/capture d’écran : `GET /snapshot`, `POST /screenshot`
- Actions : `POST /navigate`, `POST /act`
- Hooks : `POST /hooks/file-chooser`, `POST /hooks/dialog`
- Téléchargements : `POST /download`, `POST /wait/download`
- Débogage : `GET /console`, `POST /pdf`
- Débogage : `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- Réseau : `POST /response/body`
- État : `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- État : `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- Paramètres : `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

Tous les points de terminaison acceptent `?profile=<name>`.

### Exigence Playwright

Certaines fonctionnalités (navigation/action/instantané IA/instantané de rôle, captures d’éléments, PDF) nécessitent
Playwright. Si Playwright n’est pas installé, ces points de terminaison renvoient une erreur 501
claire. Les instantanés ARIA et les captures d’écran de base fonctionnent toujours pour Chrome géré par openclaw.
Pour le pilote de relais d’extension Chrome, les instantanés ARIA et les captures d’écran nécessitent Playwright.

Si vous voyez `Playwright is not available in this gateway build`, installez le package Playwright complet (pas `playwright-core`) et redémarrez la gateway,
ou réinstallez OpenClaw avec la prise en charge du navigateur.

#### Installation Playwright dans Docker

Si votre Gateway (passerelle) s’exécute dans Docker, évitez `npx playwright` (conflits d’override npm).
Utilisez plutôt la CLI fournie :

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Pour persister les téléchargements du navigateur, définissez `PLAYWRIGHT_BROWSERS_PATH` (par exemple,
`/home/node/.cache/ms-playwright`) et assurez-vous que `/home/node` est persisté via
`OPENCLAW_HOME_VOLUME` ou un montage bind. Voir [Docker](/install/docker).

## Fonctionnement (interne)

Flux de haut niveau :

- Un petit **serveur de contrôle** accepte des requêtes HTTP.
- Il se connecte aux navigateurs basés sur Chromium (Chrome/Brave/Edge/Chromium) via **CDP**.
- Pour les actions avancées (cliquer/saisir/instantané/PDF), il utilise **Playwright** au-dessus de CDP.
- Lorsque Playwright est absent, seules les opérations non-Playwright sont disponibles.

Cette conception maintient l’agent sur une interface stable et déterministe tout en vous permettant
d’interchanger navigateurs locaux/distants et profils.

## Référence rapide CLI

Toutes les commandes acceptent `--browser-profile <name>` pour cibler un profil spécifique.
Toutes les commandes acceptent également `--json` pour une sortie lisible par machine (charges utiles stables).

Bases :

- `openclaw browser status`
- `openclaw browser start`
- `openclaw browser stop`
- `openclaw browser tabs`
- `openclaw browser tab`
- `openclaw browser tab new`
- `openclaw browser tab select 2`
- `openclaw browser tab close 2`
- `openclaw browser open https://example.com`
- `openclaw browser focus abcd1234`
- `openclaw browser close abcd1234`

Inspection :

- `openclaw browser screenshot`
- `openclaw browser screenshot --full-page`
- `openclaw browser screenshot --ref 12`
- `openclaw browser screenshot --ref e12`
- `openclaw browser snapshot`
- `openclaw browser snapshot --format aria --limit 200`
- `openclaw browser snapshot --interactive --compact --depth 6`
- `openclaw browser snapshot --efficient`
- `openclaw browser snapshot --labels`
- `openclaw browser snapshot --selector "#main" --interactive`
- `openclaw browser snapshot --frame "iframe#main" --interactive`
- `openclaw browser console --level error`
- `openclaw browser errors --clear`
- `openclaw browser requests --filter api --clear`
- `openclaw browser pdf`
- `openclaw browser responsebody "**/api" --max-chars 5000`

Actions :

- `openclaw browser navigate https://example.com`
- `openclaw browser resize 1280 720`
- `openclaw browser click 12 --double`
- `openclaw browser click e12 --double`
- `openclaw browser type 23 "hello" --submit`
- `openclaw browser press Enter`
- `openclaw browser hover 44`
- `openclaw browser scrollintoview e12`
- `openclaw browser drag 10 11`
- `openclaw browser select 9 OptionA OptionB`
- `openclaw browser download e12 /tmp/report.pdf`
- `openclaw browser waitfordownload /tmp/report.pdf`
- `openclaw browser upload /tmp/file.pdf`
- `openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`
- `openclaw browser dialog --accept`
- `openclaw browser wait --text "Done"`
- `openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`
- `openclaw browser evaluate --fn '(el) => el.textContent' --ref 7`
- `openclaw browser highlight e12`
- `openclaw browser trace start`
- `openclaw browser trace stop`

État :

- `openclaw browser cookies`
- `openclaw browser cookies set session abc123 --url "https://example.com"`
- `openclaw browser cookies clear`
- `openclaw browser storage local get`
- `openclaw browser storage local set theme dark`
- `openclaw browser storage session clear`
- `openclaw browser set offline on`
- `openclaw browser set headers --json '{"X-Debug":"1"}'`
- `openclaw browser set credentials user pass`
- `openclaw browser set credentials --clear`
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `openclaw browser set geo --clear`
- `openclaw browser set media dark`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set locale en-US`
- `openclaw browser set device "iPhone 14"`

Remarques :

- `upload` et `dialog` sont des appels **d’armement** ; exécutez-les avant le clic/la touche
  qui déclenche le sélecteur/la boîte de dialogue.
- `upload` peut également définir directement des entrées de fichiers via `--input-ref` ou `--element`.
- `snapshot` :
  - `--format ai` (par défaut lorsque Playwright est installé) : renvoie un instantané IA avec des références numériques (`aria-ref="<n>"`).
  - `--format aria` : renvoie l’arbre d’accessibilité (sans références ; inspection uniquement).
  - `--efficient` (ou `--mode efficient`) : préréglage d’instantané de rôle compact (interactif + compact + profondeur + maxChars inférieur).
  - Valeur par défaut de configuration (outil/CLI uniquement) : définissez `browser.snapshotDefaults.mode: "efficient"` pour utiliser des instantanés efficaces lorsque l’appelant ne fournit pas de mode (voir [Configuration de la Gateway](/gateway/configuration#browser-openclaw-managed-browser)).
  - Options d’instantané de rôle (`--interactive`, `--compact`, `--depth`, `--selector`) forcent un instantané basé sur les rôles avec des références comme `ref=e12`.
  - `--frame "<iframe selector>"` limite les instantanés de rôle à une iframe (s’associe aux références de rôle comme `e12`).
  - `--interactive` produit une liste plate et facile à sélectionner des éléments interactifs (idéale pour piloter des actions).
  - `--labels` ajoute une capture d’écran limitée au viewport avec des étiquettes de référence superposées (affiche `MEDIA:<path>`).
- `click`/`type`/etc nécessitent une `ref` provenant de `snapshot` (soit une référence numérique `12` soit une référence de rôle `e12`).
  Les sélecteurs CSS ne sont intentionnellement pas pris en charge pour les actions.

## Instantanés et refs

OpenClaw prend en charge deux styles d’« instantané » :

- **Instantané IA (références numériques)** : `openclaw browser snapshot` (par défaut ; `--format ai`)
  - Sortie : un instantané texte incluant des références numériques.
  - Actions : `openclaw browser click 12`, `openclaw browser type 23 "hello"`.
  - En interne, la référence est résolue via `aria-ref` de Playwright.

- **Instantané de rôle (références de rôle comme `e12`)** : `openclaw browser snapshot --interactive` (ou `--compact`, `--depth`, `--selector`, `--frame`)
  - Sortie : une liste/arbre basé sur les rôles avec `[ref=e12]` (et `[nth=1]` optionnel).
  - Actions : `openclaw browser click e12`, `openclaw browser highlight e12`.
  - En interne, la référence est résolue via `getByRole(...)` (plus `nth()` pour les doublons).
  - Ajoutez `--labels` pour inclure une capture d’écran du viewport avec des étiquettes `e12` superposées.

Comportement des références :

- Les références **ne sont pas stables entre les navigations** ; si quelque chose échoue, relancez `snapshot` et utilisez une référence récente.
- Si l’instantané de rôle a été pris avec `--frame`, les références de rôle sont limitées à cette iframe jusqu’au prochain instantané de rôle.

## Amplificateurs d’attente

Vous pouvez attendre plus que le temps/texte :

- Attendre une URL (globs pris en charge par Playwright) :
  - `openclaw browser wait --url "**/dash"`
- Attendre un état de chargement :
  - `openclaw browser wait --load networkidle`
- Attendre un prédicat JS :
  - `openclaw browser wait --fn "window.ready===true"`
- Attendre qu’un sélecteur devienne visible :
  - `openclaw browser wait "#main"`

Ils peuvent être combinés :

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## Déboguer les workflows

Lorsqu’une action échoue (par ex. « not visible », « strict mode violation », « covered ») :

1. `openclaw browser snapshot --interactive`
2. Utilisez `click <ref>` / `type <ref>` (préférez les références de rôle en mode interactif)
3. Si cela échoue encore : `openclaw browser highlight <ref>` pour voir ce que Playwright cible
4. Si la page se comporte étrangement :
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. Pour un débogage approfondi : enregistrez une trace :
   - `openclaw browser trace start`
   - reproduisez le problème
   - `openclaw browser trace stop` (affiche `TRACE:<path>`)

## Sortie JSON

`--json` est destiné au scripting et aux outils structurés.

Exemples :

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

Les instantanés de rôle en JSON incluent `refs` ainsi qu’un petit bloc `stats` (lignes/caractères/références/interactif) afin que les outils puissent raisonner sur la taille et la densité de la charge utile.

## Réglages d’état et d’environnement

Utiles pour les flux « faire se comporter le site comme X » :

- Cookies : `cookies`, `cookies set`, `cookies clear`
- Stockage : `storage local|session get|set|clear`
- Hors ligne : `set offline on|off`
- En-têtes : `set headers --json '{"X-Debug":"1"}'` (ou `--clear`)
- Authentification HTTP Basic : `set credentials user pass` (ou `--clear`)
- Géolocalisation : `set geo <lat> <lon> --origin "https://example.com"` (ou `--clear`)
- Médias : `set media dark|light|no-preference|none`
- Fuseau horaire / locale : `set timezone ...`, `set locale ...`
- Appareil / viewport :
  - `set device "iPhone 14"` (préréglages d’appareils Playwright)
  - `set viewport 1280 720`

## Sécurité et confidentialité

- Le profil de navigateur openclaw peut contenir des sessions connectées ; traitez-le comme sensible.
- `browser act kind=evaluate` / `openclaw browser evaluate` et `wait --fn`
  exécutent du JavaScript arbitraire dans le contexte de la page. L’injection de prompt peut
  orienter cela. Désactivez-le avec `browser.evaluateEnabled=false` si vous n’en avez pas besoin.
- Pour les connexions et notes anti-bot (X/Twitter, etc.), voir [Connexion navigateur + publication X/Twitter](/tools/browser-login).
- Conservez la Gateway (passerelle)/l’hôte de nœud privé (loopback ou tailnet uniquement).
- Les points de terminaison CDP distants sont puissants ; tunnelisez-les et protégez-les.

## Problemes courants

Pour les problèmes spécifiques à Linux (en particulier Chromium snap), voir
[Dépannage du navigateur](/tools/browser-linux-troubleshooting).

## Outils d’agent + fonctionnement du contrôle

L’agent dispose d’**un seul outil** pour l’automatisation du navigateur :

- `browser` — statut/démarrer/arrêter/onglets/ouvrir/focaliser/fermer/instantané/capture d’écran/navigation/action

Comment elle mappe:

- `browser snapshot` renvoie une arborescence UI stable (IA ou ARIA).
- `browser act` utilise les identifiants d’instantané `ref` pour cliquer/saisir/glisser/sélectionner.
- `browser screenshot` capture des pixels (page entière ou élément).
- `browser` accepte :
  - `profile` pour choisir un profil de navigateur nommé (openclaw, chrome ou CDP distant).
  - `target` (`sandbox` | `host` | `node`) pour sélectionner l’emplacement du navigateur.
  - En sessions en sandbox, `target: "host"` nécessite `agents.defaults.sandbox.browser.allowHostControl=true`.
  - Si `target` est omis : les sessions en sandbox utilisent par défaut `sandbox`, les sessions hors sandbox utilisent par défaut `host`.
  - Si un nœud capable de navigateur est connecté, l’outil peut s’y acheminer automatiquement à moins que vous ne fixiez `target="host"` ou `target="node"`.

Cela maintient l’agent déterministe et évite les sélecteurs fragiles.
