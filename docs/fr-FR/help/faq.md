---
summary: "Questions fréquemment posées sur la configuration, la mise en place et l'utilisation d'OpenClaw"
title: "FAQ"
---

# FAQ

Réponses rapides et dépannage approfondi pour les configurations réelles (dev local, VPS, multi-agent, OAuth/clés API, basculement de modèle). Pour les diagnostics d'exécution, voir [Dépannage](/fr-FR/gateway/troubleshooting). Pour la référence de config complète, voir [Configuration](/fr-FR/gateway/configuration).

## Table des matières

- [Premières 60 secondes si quelque chose est cassé](#premières-60-secondes-si-quelque-chose-est-cassé)
- [Démarrage rapide et première installation](#démarrage-rapide-et-première-installation)
  - [Je suis bloqué - quel est le moyen le plus rapide de me débloquer ?](#je-suis-bloqué---quel-est-le-moyen-le-plus-rapide-de-me-débloquer-)
  - [Quelle est la méthode recommandée pour installer et configurer OpenClaw ?](#quelle-est-la-méthode-recommandée-pour-installer-et-configurer-openclaw-)
  - [Comment ouvrir le tableau de bord après l'onboarding ?](#comment-ouvrir-le-tableau-de-bord-après-lonboarding-)
  - [Comment authentifier le token du tableau de bord sur localhost vs distant ?](#comment-authentifier-le-token-du-tableau-de-bord-sur-localhost-vs-distant-)
  - [De quel runtime ai-je besoin ?](#de-quel-runtime-ai-je-besoin-)
  - [Est-ce que ça fonctionne sur Raspberry Pi ?](#est-ce-que-ça-fonctionne-sur-raspberry-pi-)
  - [Des conseils pour les installations Raspberry Pi ?](#des-conseils-pour-les-installations-raspberry-pi-)
  - [C'est bloqué sur "réveille-toi mon ami" / l'onboarding n'éclos pas. Que faire ?](#cest-bloqué-sur-réveille-toi-mon-ami--lonboarding-néclos-pas-que-faire-)
  - [Puis-je migrer ma configuration vers une nouvelle machine (Mac mini) sans refaire l'onboarding ?](#puis-je-migrer-ma-configuration-vers-une-nouvelle-machine-mac-mini-sans-refaire-lonboarding-)
  - [Où voir les nouveautés de la dernière version ?](#où-voir-les-nouveautés-de-la-dernière-version-)
  - [Je ne peux pas accéder à docs.openclaw.ai (erreur SSL). Que faire ?](#je-ne-peux-pas-accéder-à-docsopenclawai-erreur-ssl-que-faire-)
  - [Quelle est la différence entre stable et beta ?](#quelle-est-la-différence-entre-stable-et-beta-)
  - [Comment installer la version beta, et quelle est la différence entre beta et dev ?](#comment-installer-la-version-beta-et-quelle-est-la-différence-entre-beta-et-dev-)
  - [Comment essayer les derniers bits ?](#comment-essayer-les-derniers-bits-)
  - [Combien de temps prennent habituellement l'installation et l'onboarding ?](#combien-de-temps-prennent-habituellement-linstallation-et-lonboarding-)
  - [L'installateur est bloqué ? Comment obtenir plus de feedback ?](#linstallateur-est-bloqué--comment-obtenir-plus-de-feedback-)
  - [L'installation Windows dit git non trouvé ou openclaw non reconnu](#linstallation-windows-dit-git-non-trouvé-ou-openclaw-non-reconnu)
  - [Les docs n'ont pas répondu à ma question - comment obtenir une meilleure réponse ?](#les-docs-nont-pas-répondu-à-ma-question---comment-obtenir-une-meilleure-réponse-)
  - [Comment installer OpenClaw sur Linux ?](#comment-installer-openclaw-sur-linux-)
  - [Comment installer OpenClaw sur un VPS ?](#comment-installer-openclaw-sur-un-vps-)
  - [Où sont les guides d'installation cloud/VPS ?](#où-sont-les-guides-dinstallation-cloudvps-)
  - [Puis-je demander à OpenClaw de se mettre à jour lui-même ?](#puis-je-demander-à-openclaw-de-se-mettre-à-jour-lui-même-)
  - [Que fait réellement l'assistant d'onboarding ?](#que-fait-réellement-lassistant-donboarding-)
  - [Ai-je besoin d'un abonnement Claude ou OpenAI pour exécuter ceci ?](#ai-je-besoin-dun-abonnement-claude-ou-openai-pour-exécuter-ceci-)
  - [Puis-je utiliser l'abonnement Claude Max sans clé API ?](#puis-je-utiliser-labonnement-claude-max-sans-clé-api-)
  - [Comment fonctionne l'authentification "setup-token" Anthropic ?](#comment-fonctionne-lauthentification-setup-token-anthropic-)
  - [Où trouver un setup-token Anthropic ?](#où-trouver-un-setup-token-anthropic-)
  - [Supportez-vous l'authentification par abonnement Claude (Claude Pro ou Max) ?](#supportez-vous-lauthentification-par-abonnement-claude-claude-pro-ou-max-)
  - [Pourquoi je vois "HTTP 429: rate_limit_error" d'Anthropic ?](#pourquoi-je-vois-http-429-rate_limit_error-danthropic-)
  - [AWS Bedrock est-il supporté ?](#aws-bedrock-est-il-supporté-)
  - [Comment fonctionne l'authentification Codex ?](#comment-fonctionne-lauthentification-codex-)
  - [Supportez-vous l'authentification par abonnement OpenAI (Codex OAuth) ?](#supportez-vous-lauthentification-par-abonnement-openai-codex-oauth-)
  - [Comment configurer Gemini CLI OAuth ?](#comment-configurer-gemini-cli-oauth-)
  - [Un modèle local est-il OK pour des discussions informelles ?](#un-modèle-local-est-il-ok-pour-des-discussions-informelles-)
  - [Comment garder le trafic du modèle hébergé dans une région spécifique ?](#comment-garder-le-trafic-du-modèle-hébergé-dans-une-région-spécifique-)
  - [Dois-je acheter un Mac Mini pour installer ceci ?](#dois-je-acheter-un-mac-mini-pour-installer-ceci-)
  - [Ai-je besoin d'un Mac mini pour le support iMessage ?](#ai-je-besoin-dun-mac-mini-pour-le-support-imessage-)
  - [Si j'achète un Mac mini pour exécuter OpenClaw, puis-je le connecter à mon MacBook Pro ?](#si-jachète-un-mac-mini-pour-exécuter-openclaw-puis-je-le-connecter-à-mon-macbook-pro-)
  - [Puis-je utiliser Bun ?](#puis-je-utiliser-bun-)
  - [Telegram : que mettre dans allowFrom ?](#telegram--que-mettre-dans-allowfrom-)
  - [Plusieurs personnes peuvent-elles utiliser un numéro WhatsApp avec différentes instances OpenClaw ?](#plusieurs-personnes-peuvent-elles-utiliser-un-numéro-whatsapp-avec-différentes-instances-openclaw-)
  - [Puis-je exécuter un agent "chat rapide" et un agent "Opus pour coder" ?](#puis-je-exécuter-un-agent-chat-rapide-et-un-agent-opus-pour-coder-)
  - [Homebrew fonctionne-t-il sur Linux ?](#homebrew-fonctionne-t-il-sur-linux-)
  - [Quelle est la différence entre l'installation hackable (git) et l'installation npm ?](#quelle-est-la-différence-entre-linstallation-hackable-git-et-linstallation-npm-)
  - [Puis-je basculer entre les installations npm et git plus tard ?](#puis-je-basculer-entre-les-installations-npm-et-git-plus-tard-)
  - [Dois-je exécuter la Passerelle sur mon laptop ou un VPS ?](#dois-je-exécuter-la-passerelle-sur-mon-laptop-ou-un-vps-)
  - [Quelle importance a-t-il d'exécuter OpenClaw sur une machine dédiée ?](#quelle-importance-a-t-il-dexécuter-openclaw-sur-une-machine-dédiée-)
  - [Quels sont les requis minimaux VPS et l'OS recommandé ?](#quels-sont-les-requis-minimaux-vps-et-los-recommandé-)
  - [Puis-je exécuter OpenClaw dans une VM et quels sont les requis ?](#puis-je-exécuter-openclaw-dans-une-vm-et-quels-sont-les-requis-)
- [Qu'est-ce qu'OpenClaw ?](#quest-ce-quopenclaw-)
  - [Qu'est-ce qu'OpenClaw, en un paragraphe ?](#quest-ce-quopenclaw-en-un-paragraphe-)
  - [Quelle est la proposition de valeur ?](#quelle-est-la-proposition-de-valeur-)
  - [Je viens de le configurer - que devrais-je faire en premier ?](#je-viens-de-le-configurer---que-devrais-je-faire-en-premier-)
  - [Quels sont les cinq principaux cas d'utilisation quotidiens pour OpenClaw ?](#quels-sont-les-cinq-principaux-cas-dutilisation-quotidiens-pour-openclaw-)
  - [OpenClaw peut-il aider avec la génération de leads, l'outreach, les pubs et les blogs pour un SaaS ?](#openclaw-peut-il-aider-avec-la-génération-de-leads-loutreach-les-pubs-et-les-blogs-pour-un-saas-)
  - [Quels sont les avantages par rapport à Claude Code pour le développement web ?](#quels-sont-les-avantages-par-rapport-à-claude-code-pour-le-développement-web-)
- [Compétences et automatisation](#compétences-et-automatisation)

## Premières 60 secondes si quelque chose est cassé

1. **Statut rapide (première vérification)**

   ```bash
   openclaw status
   ```

   Résumé local rapide : OS + mise à jour, accessibilité passerelle/service, agents/sessions, config fournisseur + problèmes d'exécution (quand la passerelle est accessible).

2. **Rapport collable (sûr à partager)**

   ```bash
   openclaw status --all
   ```

   Diagnostic en lecture seule avec queue de journal (tokens caviardés).

3. **État du daemon + port**

   ```bash
   openclaw gateway status
   ```

   Montre l'exécution du superviseur vs accessibilité RPC, l'URL de sonde cible, et quelle config le service a probablement utilisée.

4. **Sondes profondes**

   ```bash
   openclaw status --deep
   ```

   Exécute les vérifications de santé de passerelle + sondes de fournisseur (nécessite une passerelle accessible). Voir [Santé](/fr-FR/gateway/health).

5. **Suivre le dernier journal**

   ```bash
   openclaw logs --follow
   ```

   Si RPC est down, repliez vers :

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   Les journaux fichiers sont séparés des journaux service ; voir [Journalisation](/fr-FR/logging) et [Dépannage](/fr-FR/gateway/troubleshooting).

6. **Exécuter le doctor (réparations)**

   ```bash
   openclaw doctor
   ```

   Répare/migre config/état + exécute des vérifications de santé. Voir [Doctor](/fr-FR/gateway/doctor).

7. **Instantané de passerelle**

   ```bash
   openclaw health --json
   openclaw health --verbose   # montre l'URL cible + chemin de config en cas d'erreurs
   ```

   Demande à la passerelle en cours d'exécution un instantané complet (WS uniquement). Voir [Santé](/fr-FR/gateway/health).

## Démarrage rapide et première installation

### Je suis bloqué - quel est le moyen le plus rapide de me débloquer ?

Utilisez un agent IA local qui peut **voir votre machine**. C'est bien plus efficace que demander dans Discord, car la plupart des cas "je suis bloqué" sont des **problèmes de config locale ou d'environnement** que les aides distantes ne peuvent pas inspecter.

- **Claude Code** : [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex** : [https://openai.com/codex/](https://openai.com/codex/)

Ces outils peuvent lire le dépôt, exécuter des commandes, inspecter les journaux et aider à corriger votre configuration niveau machine (PATH, services, permissions, fichiers d'auth). Donnez-leur le **checkout source complet** via l'installation hackable (git) :

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Cela installe OpenClaw **depuis un checkout git**, donc l'agent peut lire le code + docs et raisonner sur la version exacte que vous exécutez. Vous pouvez toujours revenir à stable plus tard en réexécutant l'installateur sans `--install-method git`.

Conseil : demandez à l'agent de **planifier et superviser** la correction (étape par étape), puis exécutez seulement les commandes nécessaires. Cela garde les changements petits et plus faciles à auditer.

Si vous découvrez un vrai bug ou correction, veuillez déposer un problème GitHub ou envoyer une PR :

- [https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
- [https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

Commencez avec ces commandes (partagez les sorties quand vous demandez de l'aide) :

```bash
openclaw status
openclaw models status
openclaw doctor
```

Ce qu'elles font :

- `openclaw status` : instantané rapide de santé passerelle/agent + config de base.
- `openclaw models status` : vérifie auth fournisseur + disponibilité modèle.
- `openclaw doctor` : valide et répare les problèmes courants de config/état.

Autres vérifications CLI utiles : `openclaw status --all`, `openclaw logs --follow`,
`openclaw gateway status`, `openclaw health --verbose`.

Boucle de débogage rapide : [Premières 60 secondes si quelque chose est cassé](#premières-60-secondes-si-quelque-chose-est-cassé).
Docs d'installation : [Installation](/fr-FR/install), [Flags de l'installateur](/fr-FR/install/installer), [Mise à jour](/fr-FR/install/updating).

### Quelle est la méthode recommandée pour installer et configurer OpenClaw ?

Le dépôt recommande d'exécuter depuis la source et d'utiliser l'assistant d'onboarding :

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
```

L'assistant peut aussi construire les assets UI automatiquement. Après l'onboarding, vous exécutez typiquement la Passerelle sur le port **18789**.

Depuis la source (contributeurs/dev) :

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # auto-installe les dépendances UI au premier lancement
openclaw onboard
```

Si vous n'avez pas encore d'installation globale, exécutez-le via `pnpm openclaw onboard`.

### Comment ouvrir le tableau de bord après l'onboarding ?

L'assistant ouvre votre navigateur avec une URL de tableau de bord propre (non tokenisée) juste après l'onboarding et imprime aussi le lien dans le résumé. Gardez cet onglet ouvert ; s'il ne s'est pas lancé, copiez/collez l'URL imprimée sur la même machine.

### Comment authentifier le token du tableau de bord sur localhost vs distant ?

**Localhost (même machine) :**

- Ouvrez `http://127.0.0.1:18789/`.
- S'il demande l'auth, collez le token depuis `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`) dans les paramètres de l'UI de contrôle.
- Récupérez-le depuis l'hôte de passerelle : `openclaw config get gateway.auth.token` (ou générez-en un : `openclaw doctor --generate-gateway-token`).

**Pas sur localhost :**

- **Tailscale Serve** (recommandé) : gardez la liaison loopback, exécutez `openclaw gateway --tailscale serve`, ouvrez `https://<magicdns>/`. Si `gateway.auth.allowTailscale` est `true`, les en-têtes d'identité satisfont l'auth (pas de token).
- **Liaison tailnet** : exécutez `openclaw gateway --bind tailnet --token "<token>"`, ouvrez `http://<tailscale-ip>:18789/`, collez le token dans les paramètres du tableau de bord.
- **Tunnel SSH** : `ssh -N -L 18789:127.0.0.1:18789 user@host` puis ouvrez `http://127.0.0.1:18789/` et collez le token dans les paramètres de l'UI de contrôle.

Voir [Tableau de bord](/fr-FR/web/dashboard) et [Surfaces web](/fr-FR/web) pour les modes de liaison et détails d'auth.

### De quel runtime ai-je besoin ?

Node **>= 22** est requis. `pnpm` est recommandé. Bun n'est **pas recommandé** pour la Passerelle.

### Est-ce que ça fonctionne sur Raspberry Pi ?

Oui. La Passerelle est légère - les docs listent **512MB-1GB RAM**, **1 cœur**, et environ **500MB** de disque comme suffisants pour un usage personnel, et notent qu'un **Raspberry Pi 4 peut l'exécuter**.

Si vous voulez de la marge supplémentaire (journaux, médias, autres services), **2GB est recommandé**, mais ce n'est pas un minimum strict.

Conseil : un petit Pi/VPS peut héberger la Passerelle, et vous pouvez appairer des **nœuds** sur votre laptop/téléphone pour un écran/caméra/canvas local ou une exécution de commande. Voir [Nœuds](/fr-FR/nodes).

### Des conseils pour les installations Raspberry Pi ?

Version courte : ça fonctionne, mais attendez-vous à quelques aspérités.

- Utilisez un OS **64-bit** et gardez Node >= 22.
- Préférez l'**installation hackable (git)** pour voir les journaux et mettre à jour rapidement.
- Commencez sans canaux/compétences, puis ajoutez-les un par un.
- Si vous rencontrez des problèmes binaires bizarres, c'est généralement un problème de **compatibilité ARM**.

Docs : [Linux](/fr-FR/platforms/linux), [Installation](/fr-FR/install).

### C'est bloqué sur "réveille-toi mon ami" / l'onboarding n'éclos pas. Que faire ?

Cet écran dépend de la Passerelle étant accessible et authentifiée. La TUI envoie aussi "Réveille-toi, mon ami !" automatiquement au premier éclosion. Si vous voyez cette ligne sans **réponse** et les tokens restent à 0, l'agent n'a jamais fonctionné.

1. Redémarrez la Passerelle :

```bash
openclaw gateway restart
```

2. Vérifiez le statut + auth :

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

3. S'il reste bloqué, exécutez :

```bash
openclaw doctor
```

Si la Passerelle est distante, assurez-vous que le tunnel/connexion Tailscale est actif et que l'UI pointe vers la bonne Passerelle. Voir [Accès distant](/fr-FR/gateway/remote).

### Puis-je migrer ma configuration vers une nouvelle machine (Mac mini) sans refaire l'onboarding ?

Oui. Copiez le **répertoire d'état** et le **workspace**, puis exécutez Doctor une fois. Cela garde votre bot "exactement le même" (mémoire, historique de session, auth et état de canal) tant que vous copiez **les deux** emplacements :

1. Installez OpenClaw sur la nouvelle machine.
2. Copiez `$OPENCLAW_STATE_DIR` (par défaut : `~/.openclaw`) depuis l'ancienne machine.
3. Copiez votre workspace (par défaut : `~/.openclaw/workspace`).
4. Exécutez `openclaw doctor` et redémarrez le service Passerelle.

Cela préserve config, profils d'auth, identifiants WhatsApp, sessions et mémoire. Si vous êtes en mode distant, rappelez-vous que l'hôte passerelle possède le magasin de sessions et le workspace.

**Important :** si vous ne faites que commit/push de votre workspace vers GitHub, vous sauvegardez **mémoire + fichiers bootstrap**, mais **pas** l'historique de session ou auth. Ceux-ci vivent sous `~/.openclaw/` (par exemple `~/.openclaw/agents/<agentId>/sessions/`).

Connexe : [Migration](/fr-FR/install/migrating), [Où les choses vivent sur disque](/fr-FR/help/faq#ou-openclaw-stocke-t-il-ses-donnees),
[Workspace agent](/fr-FR/concepts/agent-workspace), [Doctor](/fr-FR/gateway/doctor),
[Mode distant](/fr-FR/gateway/remote).

### Où voir les nouveautés de la dernière version ?

Consultez le changelog GitHub :
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

Les entrées les plus récentes sont en haut. Si la section du haut est marquée **Unreleased**, la prochaine section datée est la dernière version livrée. Les entrées sont groupées par **Highlights**, **Changes** et **Fixes** (plus sections docs/autres quand nécessaire).

### Je ne peux pas accéder à docs.openclaw.ai (erreur SSL). Que faire ?

Certaines connexions Comcast/Xfinity bloquent incorrectement `docs.openclaw.ai` via Xfinity Advanced Security. Désactivez-le ou ajoutez `docs.openclaw.ai` à la liste autorisée, puis réessayez. Plus de détails : [Dépannage](/fr-FR/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity).
Aidez-nous à débloquer ceci en signalant ici : [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

Si vous ne pouvez toujours pas atteindre le site, les docs sont mirées sur GitHub :
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### Quelle est la différence entre stable et beta ?

**Stable** et **beta** sont des **npm dist-tags**, pas des lignes de code séparées :

- `latest` = stable
- `beta` = build précoce pour tests

Nous livrons les builds vers **beta**, les testons, et une fois qu'un build est solide nous **promouvons cette même version vers `latest`**. C'est pourquoi beta et stable peuvent pointer vers la **même version**.

Voir ce qui a changé :
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### Comment installer la version beta, et quelle est la différence entre beta et dev ?

**Beta** est le npm dist-tag `beta` (peut correspondre à `latest`).
**Dev** est la tête mobile de `main` (git) ; quand publié, il utilise le npm dist-tag `dev`.

One-liners (macOS/Linux) :

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Installateur Windows (PowerShell) :
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

Plus de détails : [Canaux de développement](/fr-FR/install/development-channels) et [Flags de l'installateur](/fr-FR/install/installer).

### Comment essayer les derniers bits ?

Deux options :

1. **Canal dev (checkout git) :**

```bash
openclaw update --channel dev
```

Cela bascule vers la branche `main` et met à jour depuis la source.

2. **Installation hackable (depuis le site de l'installateur) :**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Cela vous donne un dépôt local que vous pouvez éditer, puis mettre à jour via git.

Si vous préférez un clone propre manuellement, utilisez :

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

Docs : [Mise à jour](/fr-FR/cli/update), [Canaux de développement](/fr-FR/install/development-channels),
[Installation](/fr-FR/install).

### Combien de temps prennent habituellement l'installation et l'onboarding ?

Guide approximatif :

- **Installation :** 2-5 minutes
- **Onboarding :** 5-15 minutes selon combien de canaux/modèles vous configurez

S'il se bloque, utilisez [Installateur bloqué](/fr-FR/help/faq#linstallateur-est-bloque--comment-obtenir-plus-de-feedback)
et la boucle de débogage rapide dans [Je suis bloqué](/fr-FR/help/faq#je-suis-bloque-quel-est-le-moyen-le-plus-rapide-de-me-debloquer).

### L'installateur est bloqué ? Comment obtenir plus de feedback ?

Réexécutez l'installateur avec **sortie verbeuse** :

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

Installation beta avec verbose :

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

Pour une installation hackable (git) :

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
```

Équivalent Windows (PowerShell) :

```powershell
# install.ps1 n'a pas encore de flag -Verbose dédié.
Set-PSDebug -Trace 1
& ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
Set-PSDebug -Trace 0
```

Plus d'options : [Flags de l'installateur](/fr-FR/install/installer).

### L'installation Windows dit git non trouvé ou openclaw non reconnu

Deux problèmes Windows courants :

**1) erreur npm spawn git / git non trouvé**

- Installez **Git for Windows** et assurez-vous que `git` est sur votre PATH.
- Fermez et rouvrez PowerShell, puis réexécutez l'installateur.

**2) openclaw n'est pas reconnu après installation**

- Votre dossier bin global npm n'est pas sur PATH.
- Vérifiez le chemin :

  ```powershell
  npm config get prefix
  ```

- Assurez-vous que `<prefix>\\bin` est sur PATH (sur la plupart des systèmes c'est `%AppData%\\npm`).
- Fermez et rouvrez PowerShell après mise à jour de PATH.

Si vous voulez la configuration Windows la plus fluide, utilisez **WSL2** au lieu de Windows natif.
Docs : [Windows](/fr-FR/platforms/windows).

### Les docs n'ont pas répondu à ma question - comment obtenir une meilleure réponse ?

Utilisez l'**installation hackable (git)** pour avoir la source complète et les docs localement, puis demandez à votre bot (ou Claude/Codex) _depuis ce dossier_ pour qu'il puisse lire le dépôt et répondre précisément.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Plus de détails : [Installation](/fr-FR/install) et [Flags de l'installateur](/fr-FR/install/installer).

### Comment installer OpenClaw sur Linux ?

Réponse courte : suivez le guide Linux, puis exécutez l'assistant d'onboarding.

- Chemin rapide Linux + installation service : [Linux](/fr-FR/platforms/linux).
- Parcours complet : [Démarrage](/fr-FR/start/getting-started).
- Installateur + mises à jour : [Installation & mises à jour](/fr-FR/install/updating).

### Comment installer OpenClaw sur un VPS ?

N'importe quel VPS Linux fonctionne. Installez sur le serveur, puis utilisez SSH/Tailscale pour atteindre la Passerelle.

Guides : [exe.dev](/fr-FR/install/exe-dev), [Hetzner](/fr-FR/install/hetzner), [Fly.io](/fr-FR/install/fly).
Accès distant : [Passerelle distante](/fr-FR/gateway/remote).

### Où sont les guides d'installation cloud/VPS ?

Nous maintenons un **hub d'hébergement** avec les fournisseurs courants. Choisissez-en un et suivez le guide :

- [Hébergement VPS](/fr-FR/vps) (tous les fournisseurs en un seul endroit)
- [Fly.io](/fr-FR/install/fly)
- [Hetzner](/fr-FR/install/hetzner)
- [exe.dev](/fr-FR/install/exe-dev)

Comment ça fonctionne dans le cloud : la **Passerelle fonctionne sur le serveur**, et vous y accédez depuis votre laptop/téléphone via l'UI de contrôle (ou Tailscale/SSH). Votre état + workspace vivent sur le serveur, donc traitez l'hôte comme source de vérité et sauvegardez-le.

Vous pouvez appairer des **nœuds** (Mac/iOS/Android/headless) à cette Passerelle cloud pour accéder à l'écran/caméra/canvas local ou exécuter des commandes sur votre laptop tout en gardant la Passerelle dans le cloud.

Hub : [Plateformes](/fr-FR/platforms). Accès distant : [Passerelle distante](/fr-FR/gateway/remote).
Nœuds : [Nœuds](/fr-FR/nodes), [Nœuds CLI](/fr-FR/cli/nodes).

### Puis-je demander à OpenClaw de se mettre à jour lui-même ?

Réponse courte : **possible, non recommandé**. Le flux de mise à jour peut redémarrer la Passerelle (ce qui abandonne la session active), peut nécessiter un checkout git propre, et peut demander confirmation. Plus sûr : exécutez les mises à jour depuis un shell en tant qu'opérateur.

Utilisez la CLI :

```bash
openclaw update
openclaw update status
openclaw update --channel stable|beta|dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

Si vous devez absolument automatiser depuis un agent :

```bash
openclaw update --yes --no-restart
openclaw gateway restart
```

Docs : [Mise à jour](/fr-FR/cli/update), [Mise à jour](/fr-FR/install/updating).

### Que fait réellement l'assistant d'onboarding ?

`openclaw onboard` est le chemin de configuration recommandé. En **mode local** il vous guide à travers :

- **Configuration modèle/auth** (Anthropic **setup-token** recommandé pour abonnements Claude, OpenAI Codex OAuth supporté, clés API optionnelles, modèles locaux LM Studio supportés)
- Emplacement **workspace** + fichiers bootstrap
- **Paramètres de passerelle** (bind/port/auth/tailscale)
- **Fournisseurs** (WhatsApp, Telegram, Discord, Mattermost (plugin), Signal, iMessage)
- **Installation daemon** (LaunchAgent sur macOS ; unité utilisateur systemd sur Linux/WSL2)
- **Vérifications de santé** et sélection de **compétences**

Il avertit aussi si votre modèle configuré est inconnu ou manque d'auth.

### Ai-je besoin d'un abonnement Claude ou OpenAI pour exécuter ceci ?

Non. Vous pouvez exécuter OpenClaw avec des **clés API** (Anthropic/OpenAI/autres) ou avec des **modèles locaux uniquement** pour que vos données restent sur votre appareil. Les abonnements (Claude Pro/Max ou OpenAI Codex) sont des moyens optionnels d'authentifier ces fournisseurs.

Docs : [Anthropic](/fr-FR/providers/anthropic), [OpenAI](/fr-FR/providers/openai),
[Modèles locaux](/fr-FR/gateway/local-models), [Modèles](/fr-FR/concepts/models).

### Puis-je utiliser l'abonnement Claude Max sans clé API ?

Oui. Vous pouvez vous authentifier avec un **setup-token** au lieu d'une clé API. C'est le chemin d'abonnement.

Les abonnements Claude Pro/Max **n'incluent pas de clé API**, donc c'est l'approche correcte pour les comptes d'abonnement. Important : vous devez vérifier avec Anthropic que cette utilisation est autorisée selon leur politique d'abonnement et conditions. Si vous voulez le chemin le plus explicite et supporté, utilisez une clé API Anthropic.

### Comment fonctionne l'authentification "setup-token" Anthropic ?

`claude setup-token` génère une **chaîne de token** via la Claude Code CLI (elle n'est pas disponible dans la console web). Vous pouvez l'exécuter sur **n'importe quelle machine**. Choisissez **Anthropic token (paste setup-token)** dans l'assistant ou collez-le avec `openclaw models auth paste-token --provider anthropic`. Le token est stocké comme profil d'auth pour le fournisseur **anthropic** et utilisé comme une clé API (pas de rafraîchissement auto). Plus de détails : [OAuth](/fr-FR/concepts/oauth).

### Où trouver un setup-token Anthropic ?

Ce n'est **pas** dans la Console Anthropic. Le setup-token est généré par la **Claude Code CLI** sur **n'importe quelle machine** :

```bash
claude setup-token
```

Copiez le token qu'elle imprime, puis choisissez **Anthropic token (paste setup-token)** dans l'assistant. Si vous voulez l'exécuter sur l'hôte de passerelle, utilisez `openclaw models auth setup-token --provider anthropic`. Si vous avez exécuté `claude setup-token` ailleurs, collez-le sur l'hôte de passerelle avec `openclaw models auth paste-token --provider anthropic`. Voir [Anthropic](/fr-FR/providers/anthropic).

### Supportez-vous l'authentification par abonnement Claude (Claude Pro ou Max) ?

Oui - via **setup-token**. OpenClaw ne réutilise plus les tokens OAuth de Claude Code CLI ; utilisez un setup-token ou une clé API Anthropic. Générez le token n'importe où et collez-le sur l'hôte de passerelle. Voir [Anthropic](/fr-FR/providers/anthropic) et [OAuth](/fr-FR/concepts/oauth).

Note : l'accès par abonnement Claude est régi par les conditions d'Anthropic. Pour les charges de travail de production ou multi-utilisateurs, les clés API sont généralement le choix le plus sûr.

### Pourquoi je vois "HTTP 429: rate_limit_error" d'Anthropic ?

Cela signifie que votre **quota/limite de taux Anthropic** est épuisé pour la fenêtre actuelle. Si vous utilisez un **abonnement Claude** (setup-token ou Claude Code OAuth), attendez que la fenêtre se réinitialise ou améliorez votre plan. Si vous utilisez une **clé API Anthropic**, vérifiez la Console Anthropic pour l'utilisation/facturation et augmentez les limites si nécessaire.

Conseil : définissez un **modèle de secours** pour qu'OpenClaw puisse continuer à répondre pendant qu'un fournisseur est limité en taux.
Voir [Modèles](/fr-FR/cli/models) et [OAuth](/fr-FR/concepts/oauth).

### AWS Bedrock est-il supporté ?

Oui - via le fournisseur **Amazon Bedrock (Converse)** de pi-ai avec **config manuelle**. Vous devez fournir les identifiants/région AWS sur l'hôte de passerelle et ajouter une entrée de fournisseur Bedrock dans votre config modèles. Voir [Amazon Bedrock](/fr-FR/providers/bedrock) et [Fournisseurs de modèles](/fr-FR/providers/models). Si vous préférez un flux de clés géré, un proxy compatible OpenAI devant Bedrock reste une option valide.

### Comment fonctionne l'authentification Codex ?

OpenClaw supporte **OpenAI Code (Codex)** via OAuth (connexion ChatGPT). L'assistant peut exécuter le flux OAuth et définira le modèle par défaut sur `openai-codex/gpt-5.3-codex` quand approprié. Voir [Fournisseurs de modèles](/fr-FR/concepts/model-providers) et [Assistant](/fr-FR/start/wizard).

### Supportez-vous l'authentification par abonnement OpenAI (Codex OAuth) ?

Oui. OpenClaw supporte complètement **OpenAI Code (Codex) OAuth d'abonnement**. L'assistant d'onboarding peut exécuter le flux OAuth pour vous.

Voir [OAuth](/fr-FR/concepts/oauth), [Fournisseurs de modèles](/fr-FR/concepts/model-providers), et [Assistant](/fr-FR/start/wizard).

### Comment configurer Gemini CLI OAuth ?

Gemini CLI utilise un **flux d'auth plugin**, pas un client id ou secret dans `openclaw.json`.

Étapes :

1. Activez le plugin : `openclaw plugins enable google-gemini-cli-auth`
2. Connexion : `openclaw models auth login --provider google-gemini-cli --set-default`

Cela stocke les tokens OAuth dans les profils d'auth sur l'hôte de passerelle. Détails : [Fournisseurs de modèles](/fr-FR/concepts/model-providers).

### Un modèle local est-il OK pour des discussions informelles ?

Généralement non. OpenClaw a besoin de contexte large + sécurité forte ; les petites cartes tronquent et fuient. Si vous devez absolument, exécutez la **plus grande** construction MiniMax M2.1 que vous pouvez localement (LM Studio) et voir [/gateway/local-models](/fr-FR/gateway/local-models). Les modèles plus petits/quantifiés augmentent le risque d'injection de prompt - voir [Sécurité](/fr-FR/gateway/security).

### Comment garder le trafic du modèle hébergé dans une région spécifique ?

Choisissez des points de terminaison épinglés par région. OpenRouter expose des options hébergées US pour MiniMax, Kimi et GLM ; choisissez la variante hébergée US pour garder les données en région. Vous pouvez toujours lister Anthropic/OpenAI à côté en utilisant `models.mode: "merge"` pour que les secours restent disponibles tout en respectant le fournisseur régionalisé que vous sélectionnez.

### Dois-je acheter un Mac Mini pour installer ceci ?

Non. OpenClaw fonctionne sur macOS ou Linux (Windows via WSL2). Un Mac mini est optionnel - certaines personnes en achètent un comme hôte toujours actif, mais un petit VPS, serveur maison, ou boîtier classe Raspberry Pi fonctionne aussi.

Vous n'avez besoin d'un Mac **que pour les outils macOS uniquement**. Pour iMessage, utilisez [BlueBubbles](/fr-FR/channels/bluebubbles) (recommandé) - le serveur BlueBubbles fonctionne sur n'importe quel Mac, et la Passerelle peut fonctionner sur Linux ou ailleurs. Si vous voulez d'autres outils macOS uniquement, exécutez la Passerelle sur un Mac ou appairez un nœud macOS.

Docs : [BlueBubbles](/fr-FR/channels/bluebubbles), [Nœuds](/fr-FR/nodes), [Mode distant Mac](/fr-FR/platforms/mac/remote).

### Ai-je besoin d'un Mac mini pour le support iMessage ?

Vous avez besoin de **quelque appareil macOS** connecté à Messages. Ce **n'est pas obligé** d'être un Mac mini - n'importe quel Mac fonctionne. **Utilisez [BlueBubbles](/fr-FR/channels/bluebubbles)** (recommandé) pour iMessage - le serveur BlueBubbles fonctionne sur macOS, tandis que la Passerelle peut fonctionner sur Linux ou ailleurs.

Configurations courantes :

- Exécutez la Passerelle sur Linux/VPS, et exécutez le serveur BlueBubbles sur n'importe quel Mac connecté à Messages.
- Exécutez tout sur le Mac si vous voulez la configuration mono-machine la plus simple.

Docs : [BlueBubbles](/fr-FR/channels/bluebubbles), [Nœuds](/fr-FR/nodes),
[Mode distant Mac](/fr-FR/platforms/mac/remote).

### Si j'achète un Mac mini pour exécuter OpenClaw, puis-je le connecter à mon MacBook Pro ?

Oui. Le **Mac mini peut exécuter la Passerelle**, et votre MacBook Pro peut se connecter comme **nœud** (appareil compagnon). Les nœuds n'exécutent pas la Passerelle - ils fournissent des capacités supplémentaires comme écran/caméra/canvas et `system.run` sur cet appareil.

Modèle courant :

- Passerelle sur le Mac mini (toujours actif).
- MacBook Pro exécute l'app macOS ou un hôte nœud et s'appaire à la Passerelle.
- Utilisez `openclaw nodes status` / `openclaw nodes list` pour le voir.

Docs : [Nœuds](/fr-FR/nodes), [Nœuds CLI](/fr-FR/cli/nodes).

### Puis-je utiliser Bun ?

Bun n'est **pas recommandé**. Nous voyons des bugs d'exécution, particulièrement avec WhatsApp et Telegram.
Utilisez **Node** pour des passerelles stables.

Si vous voulez toujours expérimenter avec Bun, faites-le sur une passerelle non-production sans WhatsApp/Telegram.

### Telegram : que mettre dans allowFrom ?

`channels.telegram.allowFrom` est **l'ID utilisateur Telegram de l'expéditeur humain** (numérique). Ce n'est pas le nom d'utilisateur du bot.

L'assistant d'onboarding accepte l'entrée `@username` et la résout en ID numérique, mais l'autorisation OpenClaw utilise uniquement des IDs numériques.

Plus sûr (pas de bot tiers) :

- Envoyez un DM à votre bot, puis exécutez `openclaw logs --follow` et lisez `from.id`.

API Bot officielle :

- Envoyez un DM à votre bot, puis appelez `https://api.telegram.org/bot<bot_token>/getUpdates` et lisez `message.from.id`.

Tiers (moins privé) :

- Envoyez un DM à `@userinfobot` ou `@getidsbot`.

Voir [/channels/telegram](/fr-FR/channels/telegram#access-control-dms--groups).

### Plusieurs personnes peuvent-elles utiliser un numéro WhatsApp avec différentes instances OpenClaw ?

Oui, via **routage multi-agent**. Liez chaque **DM** WhatsApp d'expéditeur (peer `kind: "direct"`, expéditeur E.164 comme `+15551234567`) à un `agentId` différent, pour que chaque personne obtienne son propre workspace et magasin de sessions. Les réponses viennent toujours du **même compte WhatsApp**, et le contrôle d'accès DM (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) est global par compte WhatsApp. Voir [Routage multi-agent](/fr-FR/concepts/multi-agent) et [WhatsApp](/fr-FR/channels/whatsapp).

### Puis-je exécuter un agent "chat rapide" et un agent "Opus pour coder" ?

Oui. Utilisez le routage multi-agent : donnez à chaque agent son propre modèle par défaut, puis liez les routes entrantes (compte fournisseur ou peers spécifiques) à chaque agent. Exemple de config dans [Routage multi-agent](/fr-FR/concepts/multi-agent). Voir aussi [Modèles](/fr-FR/concepts/models) et [Configuration](/fr-FR/gateway/configuration).

### Homebrew fonctionne-t-il sur Linux ?

Oui. Homebrew supporte Linux (Linuxbrew). Configuration rapide :

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

Si vous exécutez OpenClaw via systemd, assurez-vous que le PATH du service inclut `/home/linuxbrew/.linuxbrew/bin` (ou votre préfixe brew) pour que les outils installés par `brew` se résolvent dans les shells non-login.
Les builds récents préfixent aussi les répertoires bin utilisateur courants sur les services systemd Linux (par exemple `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/.bun/bin`) et honorent `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR`, et `FNM_DIR` quand définis.

### Quelle est la différence entre l'installation hackable (git) et l'installation npm ?

- **Installation hackable (git) :** checkout source complet, éditable, meilleur pour les contributeurs.
  Vous exécutez les builds localement et pouvez patcher code/docs.
- **Installation npm :** installation CLI globale, pas de dépôt, meilleur pour "juste l'exécuter."
  Les mises à jour viennent des dist-tags npm.

Docs : [Démarrage](/fr-FR/start/getting-started), [Mise à jour](/fr-FR/install/updating).

### Puis-je basculer entre les installations npm et git plus tard ?

Oui. Installez l'autre saveur, puis exécutez Doctor pour que le service passerelle pointe vers le nouveau point d'entrée.
Cela **ne supprime pas vos données** - cela change seulement l'installation du code OpenClaw. Votre état (`~/.openclaw`) et workspace (`~/.openclaw/workspace`) restent intacts.

De npm → git :

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw doctor
openclaw gateway restart
```

De git → npm :

```bash
npm install -g openclaw@latest
openclaw doctor
openclaw gateway restart
```

Doctor détecte une inadéquation de point d'entrée de service passerelle et propose de réécrire la config service pour correspondre à l'installation actuelle (utilisez `--repair` en automatisation).

Conseils de sauvegarde : voir [Stratégie de sauvegarde](/fr-FR/help/faq#quelle-est-la-strategie-de-sauvegarde-recommandee).

### Dois-je exécuter la Passerelle sur mon laptop ou un VPS ?

Réponse courte : **si vous voulez une fiabilité 24/7, utilisez un VPS**. Si vous voulez le moins de friction et que vous acceptez le sommeil/redémarrages, exécutez-le localement.

**Laptop (Passerelle locale)**

- **Avantages :** pas de coût serveur, accès direct aux fichiers locaux, fenêtre navigateur en direct.
- **Inconvénients :** sommeil/chutes réseau = déconnexions, mises à jour OS/redémarrages interrompent, doit rester éveillé.

**VPS / cloud**

- **Avantages :** toujours actif, réseau stable, pas de problèmes de sommeil laptop, plus facile à garder en cours d'exécution.
- **Inconvénients :** souvent headless (utilisez des captures d'écran), accès fichiers distant uniquement, vous devez SSH pour les mises à jour.

**Note spécifique OpenClaw :** WhatsApp/Telegram/Slack/Mattermost (plugin)/Discord fonctionnent tous bien depuis un VPS. Le seul vrai compromis est **navigateur headless** vs une fenêtre visible. Voir [Navigateur](/fr-FR/tools/browser).

**Défaut recommandé :** VPS si vous aviez des déconnexions passerelle avant. Le local est génial quand vous utilisez activement le Mac et voulez un accès fichiers local ou une automatisation UI avec un navigateur visible.

### Quelle importance a-t-il d'exécuter OpenClaw sur une machine dédiée ?

Pas requis, mais **recommandé pour la fiabilité et l'isolation**.

- **Hôte dédié (VPS/Mac mini/Pi) :** toujours actif, moins d'interruptions sommeil/redémarrage, permissions plus propres, plus facile à garder en cours d'exécution.
- **Laptop/desktop partagé :** totalement bien pour les tests et l'utilisation active, mais attendez-vous à des pauses quand la machine dort ou se met à jour.

Si vous voulez le meilleur des deux mondes, gardez la Passerelle sur un hôte dédié et appairez votre laptop comme **nœud** pour les outils locaux écran/caméra/exec. Voir [Nœuds](/fr-FR/nodes).
Pour des conseils de sécurité, lisez [Sécurité](/fr-FR/gateway/security).

### Quels sont les requis minimaux VPS et l'OS recommandé ?

OpenClaw est léger. Pour une Passerelle basique + un canal de chat :

- **Minimum absolu :** 1 vCPU, 1GB RAM, ~500MB disque.
- **Recommandé :** 1-2 vCPU, 2GB RAM ou plus pour la marge (journaux, médias, canaux multiples). Les outils nœud et l'automatisation navigateur peuvent être gourmands en ressources.

OS : utilisez **Ubuntu LTS** (ou n'importe quel Debian/Ubuntu moderne). Le chemin d'installation Linux est mieux testé là.

Docs : [Linux](/fr-FR/platforms/linux), [Hébergement VPS](/fr-FR/vps).

### Puis-je exécuter OpenClaw dans une VM et quels sont les requis ?

Oui. Traitez une VM comme un VPS : elle doit être toujours active, accessible, et avoir assez de RAM pour la Passerelle et tous les canaux que vous activez.

Guidance de base :

- **Minimum absolu :** 1 vCPU, 1GB RAM.
- **Recommandé :** 2GB RAM ou plus si vous exécutez plusieurs canaux, automatisation navigateur, ou outils médias.
- **OS :** Ubuntu LTS ou autre Debian/Ubuntu moderne.

Si vous êtes sur Windows, **WSL2 est la configuration VM la plus facile** et a la meilleure compatibilité outillage. Voir [Windows](/fr-FR/platforms/windows), [Hébergement VPS](/fr-FR/vps).
Si vous exécutez macOS dans une VM, voir [VM macOS](/fr-FR/install/macos-vm).

## Qu'est-ce qu'OpenClaw ?

### Qu'est-ce qu'OpenClaw, en un paragraphe ?

OpenClaw est un assistant IA personnel que vous exécutez sur vos propres appareils. Il répond sur les surfaces de messagerie que vous utilisez déjà (WhatsApp, Telegram, Slack, Mattermost (plugin), Discord, Google Chat, Signal, iMessage, WebChat) et peut aussi faire de la voix + un Canvas en direct sur les plateformes supportées. La **Passerelle** est le plan de contrôle toujours actif ; l'assistant est le produit.

### Quelle est la proposition de valeur ?

OpenClaw n'est pas "juste un wrapper Claude." C'est un **plan de contrôle local-first** qui vous permet d'exécuter un assistant capable sur **votre propre matériel**, accessible depuis les apps de chat que vous utilisez déjà, avec des sessions avec état, mémoire et outils - sans donner le contrôle de vos workflows à un SaaS hébergé.

Points forts :

- **Vos appareils, vos données :** exécutez la Passerelle où vous voulez (Mac, Linux, VPS) et gardez le workspace + historique de session locaux.
- **Vrais canaux, pas un sandbox web :** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc, plus voix mobile et Canvas sur plateformes supportées.
- **Agnostique modèle :** utilisez Anthropic, OpenAI, MiniMax, OpenRouter, etc., avec routage par agent et basculement.
- **Option local uniquement :** exécutez des modèles locaux pour que **toutes les données puissent rester sur votre appareil** si vous voulez.
- **Routage multi-agent :** agents séparés par canal, compte ou tâche, chacun avec son propre workspace et défauts.
- **Open source et hackable :** inspectez, étendez et auto-hébergez sans verrouillage fournisseur.

Docs : [Passerelle](/fr-FR/gateway), [Canaux](/fr-FR/channels), [Multi-agent](/fr-FR/concepts/multi-agent),
[Mémoire](/fr-FR/concepts/memory).

### Je viens de le configurer - que devrais-je faire en premier ?

Bons premiers projets :

- Construire un site web (WordPress, Shopify, ou un site statique simple).
- Prototyper une app mobile (plan, écrans, plan API).
- Organiser fichiers et dossiers (nettoyage, nommage, étiquetage).
- Connecter Gmail et automatiser résumés ou suivis.

Il peut gérer de grandes tâches, mais il fonctionne mieux quand vous les divisez en phases et utilisez des sous-agents pour le travail parallèle.

### Quels sont les cinq principaux cas d'utilisation quotidiens pour OpenClaw ?

Les victoires quotidiennes ressemblent généralement à :

- **Briefings personnels :** résumés de boîte de réception, calendrier, et nouvelles qui vous intéressent.
- **Recherche et rédaction :** recherche rapide, résumés et premiers brouillons pour emails ou docs.
- **Rappels et suivis :** coups de pouce et checklists pilotés par cron ou heartbeat.
- **Automatisation navigateur :** remplir des formulaires, collecter des données et répéter des tâches web.
- **Coordination multi-appareils :** envoyez une tâche depuis votre téléphone, laissez la Passerelle l'exécuter sur un serveur, et récupérez le résultat dans le chat.

### OpenClaw peut-il aider avec la génération de leads, l'outreach, les pubs et les blogs pour un SaaS ?

Oui pour **recherche, qualification et rédaction**. Il peut scanner des sites, construire des listes restreintes, résumer des prospects et écrire des brouillons d'outreach ou de copie publicitaire.

Pour **l'outreach ou les campagnes publicitaires**, gardez un humain dans la boucle. Évitez le spam, suivez les lois locales et les politiques des plateformes, et examinez tout avant envoi. Le modèle le plus sûr est de laisser OpenClaw rédiger et vous approuvez.

Docs : [Sécurité](/fr-FR/gateway/security).

### Quels sont les avantages par rapport à Claude Code pour le développement web ?

OpenClaw est un **assistant personnel** et couche de coordination, pas un remplacement d'IDE. Utilisez Claude Code ou Codex pour la boucle de codage directe la plus rapide dans un dépôt. Utilisez OpenClaw quand vous voulez une mémoire durable, un accès multi-appareils et une orchestration d'outils.

Avantages :

- **Mémoire + workspace persistants** entre sessions
- **Accès multi-plateforme** (WhatsApp, Telegram, TUI, WebChat)
- **Orchestration d'outils** (navigateur, fichiers, planification, hooks)
- **Passerelle toujours active** (exécuter sur un VPS, interagir de partout)
- **Nœuds** pour navigateur/écran/caméra/exec local

Vitrine : [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## Compétences et automatisation

### Comment personnaliser les compétences sans garder le dépôt sale ?

Utilisez des remplacements gérés au lieu d'éditer la copie du dépôt. Mettez vos changements dans `~/.openclaw/skills/<name>/SKILL.md` (ou ajoutez un dossier via `skills.load.extraDirs` dans `~/.openclaw/openclaw.json`). La préséance est `<workspace>/skills` > `~/.openclaw/skills` > intégré, donc les remplacements gérés gagnent sans toucher git. Seules les éditions dignes d'upstream devraient vivre dans le dépôt et sortir comme PRs.

### Puis-je charger des compétences depuis un dossier personnalisé ?

Oui. Ajoutez des répertoires supplémentaires via `skills.load.extraDirs` dans `~/.openclaw/openclaw.json` (préséance la plus basse). La préséance par défaut reste : `<workspace>/skills` → `~/.openclaw/skills` → intégré → `skills.load.extraDirs`. `clawhub` installe dans `./skills` par défaut, qu'OpenClaw traite comme `<workspace>/skills`.

### Comment puis-je utiliser différents modèles pour différentes tâches ?

Aujourd'hui les modèles supportés sont :

- **Jobs cron** : les jobs isolés peuvent définir un remplacement `model` par job.
- **Sous-agents** : routez les tâches vers des agents séparés avec différents modèles par défaut.
- **Changement à la demande** : utilisez `/model` pour changer le modèle de session actuel à tout moment.

Voir [Jobs cron](/fr-FR/automation/cron-jobs), [Routage multi-agent](/fr-FR/concepts/multi-agent), et [Commandes slash](/fr-FR/tools/slash-commands).

### Le bot se fige pendant un travail lourd. Comment décharger ça ?

Utilisez des **sous-agents** pour les tâches longues ou parallèles. Les sous-agents s'exécutent dans leur propre session, retournent un résumé et gardent votre chat principal réactif.

Demandez à votre bot de "générer un sous-agent pour cette tâche" ou utilisez `/subagents`.
Utilisez `/status` dans le chat pour voir ce que la Passerelle fait actuellement (et si elle est occupée).

Conseil de token : les tâches longues et sous-agents consomment tous deux des tokens. Si le coût est une préoccupation, définissez un modèle moins cher pour les sous-agents via `agents.defaults.subagents.model`.

Docs : [Sous-agents](/fr-FR/tools/subagents).

### Cron ou les rappels ne se déclenchent pas. Que devrais-je vérifier ?

Cron fonctionne à l'intérieur du processus Passerelle. Si la Passerelle ne fonctionne pas continuellement, les jobs planifiés ne s'exécuteront pas.

Checklist :

- Confirmez que cron est activé (`cron.enabled`) et que `OPENCLAW_SKIP_CRON` n'est pas défini.
- Vérifiez que la Passerelle fonctionne 24/7 (pas de sommeil/redémarrages).
- Vérifiez les paramètres de fuseau horaire pour le job (`--tz` vs fuseau horaire hôte).

Débogage :

```bash
openclaw cron run <jobId> --force
openclaw cron runs --id <jobId> --limit 50
```

Docs : [Jobs cron](/fr-FR/automation/cron-jobs), [Cron vs Heartbeat](/fr-FR/automation/cron-vs-heartbeat).

### Comment installer des compétences sur Linux ?

Utilisez **ClawHub** (CLI) ou déposez des compétences dans votre workspace. L'UI Compétences macOS n'est pas disponible sur Linux.
Parcourez les compétences sur [https://clawhub.com](https://clawhub.com).

Installez la CLI ClawHub (choisissez un gestionnaire de paquets) :

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### OpenClaw peut-il exécuter des tâches sur un horaire ou continuellement en arrière-plan ?

Oui. Utilisez le planificateur de Passerelle :

- **Jobs cron** pour tâches planifiées ou récurrentes (persistent entre redémarrages).
- **Heartbeat** pour vérifications périodiques "session principale".
- **Jobs isolés** pour agents autonomes qui postent des résumés ou livrent aux chats.

Docs : [Jobs cron](/fr-FR/automation/cron-jobs), [Cron vs Heartbeat](/fr-FR/automation/cron-vs-heartbeat),
[Heartbeat](/fr-FR/gateway/heartbeat).

### Puis-je exécuter des compétences macOS uniquement depuis Linux ?

Pas directement. Les compétences macOS sont bloquées par `metadata.openclaw.os` plus binaires requis, et les compétences n'apparaissent dans le prompt système que quand elles sont éligibles sur l'**hôte Passerelle**. Sur Linux, les compétences `darwin` uniquement (comme `apple-notes`, `apple-reminders`, `things-mac`) ne se chargeront pas sauf si vous remplacez le blocage.

Vous avez trois modèles supportés :

**Option A - exécutez la Passerelle sur un Mac (le plus simple).**
Exécutez la Passerelle où les binaires macOS existent, puis connectez-vous depuis Linux en [mode distant](#quest-ce-que-le-mode-distant-de-la-passerelle-) ou via Tailscale. Les compétences se chargent normalement parce que l'hôte Passerelle est macOS.

**Option B - utilisez un nœud macOS (pas de SSH).**
Exécutez la Passerelle sur Linux, appairez un nœud macOS (app menubar), et définissez **Commandes d'exécution nœud** sur "Toujours demander" ou "Toujours autoriser" sur le Mac. OpenClaw peut traiter les compétences macOS uniquement comme éligibles quand les binaires requis existent sur le nœud. L'agent exécute ces compétences via l'outil `nodes`. Si vous choisissez "Toujours demander", approuver "Toujours autoriser" dans le prompt ajoute cette commande à la liste autorisée.

**Option C - proxifier les binaires macOS via SSH (avancé).**
Gardez la Passerelle sur Linux, mais faites résoudre les binaires CLI requis à des wrappers SSH qui s'exécutent sur un Mac. Puis remplacez la compétence pour autoriser Linux pour qu'elle reste éligible.

1. Créez un wrapper SSH pour le binaire (exemple : `memo` pour Apple Notes) :

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```

2. Mettez le wrapper sur `PATH` sur l'hôte Linux (par exemple `~/bin/memo`).
3. Remplacez les métadonnées de compétence (workspace ou `~/.openclaw/skills`) pour autoriser Linux :

   ```markdown
   ---
   name: apple-notes
   description: Gérer Apple Notes via la CLI memo sur macOS.
   metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
   ---
   ```

4. Commencez une nouvelle session pour que l'instantané des compétences se rafraîchisse.

### Avez-vous une intégration Notion ou HeyGen ?

Pas intégré aujourd'hui.

Options :

- **Compétence / plugin personnalisé :** meilleur pour un accès API fiable (Notion/HeyGen ont tous deux des APIs).
- **Automatisation navigateur :** fonctionne sans code mais est plus lent et plus fragile.

Si vous voulez garder le contexte par client (workflows agence), un modèle simple est :

- Une page Notion par client (contexte + préférences + travail actif).
- Demandez à l'agent de récupérer cette page au début d'une session.

Si vous voulez une intégration native, ouvrez une demande de fonctionnalité ou construisez une compétence ciblant ces APIs.

Installez des compétences :

```bash
clawhub install <skill-slug>
clawhub update --all
```

ClawHub installe dans `./skills` sous votre répertoire actuel (ou replie vers votre workspace OpenClaw configuré) ; OpenClaw traite ça comme `<workspace>/skills` à la prochaine session. Pour des compétences partagées entre agents, placez-les dans `~/.openclaw/skills/<name>/SKILL.md`. Certaines compétences attendent des binaires installés via Homebrew ; sur Linux cela signifie Linuxbrew (voir l'entrée FAQ Homebrew Linux ci-dessus). Voir [Compétences](/fr-FR/tools/skills) et [ClawHub](/fr-FR/tools/clawhub).

### Comment installer l'extension Chrome pour la prise de contrôle du navigateur ?

Utilisez l'installateur intégré, puis chargez l'extension décompressée dans Chrome :

```bash
openclaw browser extension install
openclaw browser extension path
```

Puis Chrome → `chrome://extensions` → activez "Mode développeur" → "Charger l'extension non empaquetée" → choisissez ce dossier.

Guide complet (incluant Passerelle distante + notes de sécurité) : [Extension Chrome](/fr-FR/tools/chrome-extension)

Si la Passerelle fonctionne sur la même machine que Chrome (configuration par défaut), vous n'avez généralement **rien** besoin de plus.
Si la Passerelle fonctionne ailleurs, exécutez un hôte nœud sur la machine navigateur pour que la Passerelle puisse proxifier les actions navigateur.
Vous devez toujours cliquer sur le bouton d'extension sur l'onglet que vous voulez contrôler (il ne s'attache pas automatiquement).

## Sandboxing et mémoire

### Y a-t-il un doc dédié au sandboxing ?

Oui. Voir [Sandboxing](/fr-FR/gateway/sandboxing). Pour la configuration spécifique Docker (passerelle complète dans Docker ou images sandbox), voir [Docker](/fr-FR/install/docker).

### Docker semble limité. Comment activer les fonctionnalités complètes ?

L'image par défaut est sécurité d'abord et s'exécute comme l'utilisateur `node`, donc elle n'inclut pas les paquets système, Homebrew, ou les navigateurs intégrés. Pour une configuration plus complète :

- Persistez `/home/node` avec `OPENCLAW_HOME_VOLUME` pour que les caches survivent.
- Intégrez les dépendances système dans l'image avec `OPENCLAW_DOCKER_APT_PACKAGES`.
- Installez les navigateurs Playwright via la CLI intégrée :
  `node /app/node_modules/playwright-core/cli.js install chromium`
- Définissez `PLAYWRIGHT_BROWSERS_PATH` et assurez-vous que le chemin est persisté.

Docs : [Docker](/fr-FR/install/docker), [Navigateur](/fr-FR/tools/browser).

**Puis-je garder les DMs personnels mais rendre les groupes publics sandboxés avec un agent ?**

Oui - si votre trafic privé est en **DMs** et votre trafic public en **groupes**.

Utilisez `agents.defaults.sandbox.mode: "non-main"` pour que les sessions groupe/canal (clés non-main) s'exécutent dans Docker, tandis que la session DM principale reste sur l'hôte. Puis restreignez quels outils sont disponibles dans les sessions sandboxées via `tools.sandbox.tools`.

Parcours de configuration + exemple config : [Groupes : DMs personnels + groupes publics](/fr-FR/channels/groups#pattern-personal-dms-public-groups-single-agent)

Référence config clé : [Configuration de passerelle](/fr-FR/gateway/configuration#agentsdefaultssandbox)

### Comment lier un dossier hôte dans le sandbox ?

Définissez `agents.defaults.sandbox.docker.binds` sur `["host:path:mode"]` (ex., `"/home/user/src:/src:ro"`). Les liaisons globales + par agent fusionnent ; les liaisons par agent sont ignorées quand `scope: "shared"`. Utilisez `:ro` pour tout ce qui est sensible et rappelez-vous que les liaisons contournent les murs du système de fichiers sandbox. Voir [Sandboxing](/fr-FR/gateway/sandboxing#custom-bind-mounts) et [Sandbox vs Tool Policy vs Elevated](/fr-FR/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) pour des exemples et notes de sécurité.

### Comment fonctionne la mémoire ?

La mémoire OpenClaw ce sont juste des fichiers Markdown dans le workspace agent :

- Notes quotidiennes dans `memory/YYYY-MM-DD.md`
- Notes curées long-terme dans `MEMORY.md` (sessions main/privées uniquement)

OpenClaw exécute aussi un **flush mémoire pré-compaction silencieux** pour rappeler au modèle d'écrire des notes durables avant l'auto-compaction. Cela s'exécute uniquement quand le workspace est inscriptible (les sandboxes en lecture seule le sautent). Voir [Mémoire](/fr-FR/concepts/memory).

### La mémoire continue d'oublier des choses. Comment faire adhérer ?

Demandez au bot d'**écrire le fait en mémoire**. Les notes long-terme appartiennent à `MEMORY.md`, le contexte court-terme va dans `memory/YYYY-MM-DD.md`.

C'est toujours un domaine que nous améliorons. Ça aide de rappeler au modèle de stocker les mémoires ; il saura quoi faire. S'il continue d'oublier, vérifiez que la Passerelle utilise le même workspace à chaque exécution.

Docs : [Mémoire](/fr-FR/concepts/memory), [Workspace agent](/fr-FR/concepts/agent-workspace).

### La recherche mémoire sémantique nécessite-t-elle une clé API OpenAI ?

Seulement si vous utilisez **les embeddings OpenAI**. Codex OAuth couvre chat/complétions et n'accorde **pas** l'accès embeddings, donc **se connecter avec Codex (OAuth ou la connexion CLI Codex)** n'aide pas pour la recherche mémoire sémantique. Les embeddings OpenAI ont toujours besoin d'une vraie clé API (`OPENAI_API_KEY` ou `models.providers.openai.apiKey`).

Si vous ne définissez pas explicitement un fournisseur, OpenClaw auto-sélectionne un fournisseur quand il peut résoudre une clé API (profils d'auth, `models.providers.*.apiKey`, ou vars env).
Il préfère OpenAI si une clé OpenAI se résout, sinon Gemini si une clé Gemini se résout. Si aucune clé n'est disponible, la recherche mémoire reste désactivée jusqu'à ce que vous la configuriez. Si vous avez un chemin de modèle local configuré et présent, OpenClaw préfère `local`.

Si vous préférez rester local, définissez `memorySearch.provider = "local"` (et optionnellement `memorySearch.fallback = "none"`). Si vous voulez les embeddings Gemini, définissez `memorySearch.provider = "gemini"` et fournissez `GEMINI_API_KEY` (ou `memorySearch.remote.apiKey`). Nous supportons les modèles d'embedding **OpenAI, Gemini ou local** - voir [Mémoire](/fr-FR/concepts/memory) pour les détails de configuration.

### La mémoire persiste-t-elle pour toujours ? Quelles sont les limites ?

Les fichiers mémoire vivent sur disque et persistent jusqu'à ce que vous les supprimiez. La limite est votre stockage, pas le modèle. Le **contexte de session** est toujours limité par la fenêtre de contexte du modèle, donc les longues conversations peuvent compacter ou tronquer. C'est pourquoi la recherche mémoire existe - elle retire uniquement les parties pertinentes dans le contexte.

Docs : [Mémoire](/fr-FR/concepts/memory), [Contexte](/fr-FR/concepts/context).

## Où les choses vivent sur le disque

### Toutes les données utilisées avec OpenClaw sont-elles sauvegardées localement ?

Non - **l'état d'OpenClaw est local**, mais **les services externes voient toujours ce que vous leur envoyez**.

- **Local par défaut :** sessions, fichiers mémoire, config et workspace vivent sur l'hôte Passerelle (`~/.openclaw` + votre répertoire workspace).
- **Distant par nécessité :** les messages que vous envoyez aux fournisseurs de modèles (Anthropic/OpenAI/etc.) vont à leurs APIs, et les plateformes de chat (WhatsApp/Telegram/Slack/etc.) stockent les données de message sur leurs serveurs.
- **Vous contrôlez l'empreinte :** utiliser des modèles locaux garde les prompts sur votre machine, mais le trafic des canaux passe toujours par les serveurs du canal.

Connexe : [Workspace agent](/fr-FR/concepts/agent-workspace), [Mémoire](/fr-FR/concepts/memory).

### Où OpenClaw stocke-t-il ses données ?

Tout vit sous `$OPENCLAW_STATE_DIR` (par défaut : `~/.openclaw`) :

| Chemin                                                          | Objectif                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------- |
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | Config principale (JSON5)                                      |
| `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | Import OAuth legacy (copié dans profils auth au premier usage) |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | Profils d'auth (OAuth + clés API)                              |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | Cache d'auth runtime (géré automatiquement)                    |
| `$OPENCLAW_STATE_DIR/credentials/`                              | État fournisseur (ex. `whatsapp/<accountId>/creds.json`)       |
| `$OPENCLAW_STATE_DIR/agents/`                                   | État par agent (agentDir + sessions)                           |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | Historique & état conversation (par agent)                     |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | Métadonnées session (par agent)                                |

Chemin agent unique legacy : `~/.openclaw/agent/*` (migré par `openclaw doctor`).

Votre **workspace** (AGENTS.md, fichiers mémoire, compétences, etc.) est séparé et configuré via `agents.defaults.workspace` (par défaut : `~/.openclaw/workspace`).

### Où devraient vivre AGENTS.md, SOUL.md, USER.md, MEMORY.md ?

Ces fichiers vivent dans le **workspace agent**, pas `~/.openclaw`.

- **Workspace (par agent)** : `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md` (ou `memory.md`), `memory/YYYY-MM-DD.md`, `HEARTBEAT.md` optionnel.
- **Répertoire d'état (`~/.openclaw`)** : config, identifiants, profils d'auth, sessions, journaux et compétences partagées (`~/.openclaw/skills`).

Le workspace par défaut est `~/.openclaw/workspace`, configurable via :

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

Si le bot "oublie" après un redémarrage, confirmez que la Passerelle utilise le même workspace à chaque lancement (et rappelez-vous : le mode distant utilise le workspace de **l'hôte passerelle**, pas votre laptop local).

Conseil : si vous voulez un comportement ou préférence durable, demandez au bot de **l'écrire dans AGENTS.md ou MEMORY.md** plutôt que de compter sur l'historique de chat.

Voir [Workspace agent](/fr-FR/concepts/agent-workspace) et [Mémoire](/fr-FR/concepts/memory).

### Quelle est la stratégie de sauvegarde recommandée ?

Mettez votre **workspace agent** dans un dépôt git **privé** et sauvegardez-le quelque part en privé (par exemple GitHub privé). Cela capture mémoire + fichiers AGENTS/SOUL/USER, et vous permet de restaurer "l'esprit" de l'assistant plus tard.

Ne committez **rien** sous `~/.openclaw` (identifiants, sessions, tokens).
Si vous avez besoin d'une restauration complète, sauvegardez à la fois le workspace et le répertoire d'état séparément (voir la question migration ci-dessus).

Docs : [Workspace agent](/fr-FR/concepts/agent-workspace).

### Comment désinstaller complètement OpenClaw ?

Voir le guide dédié : [Désinstallation](/fr-FR/install/uninstall).

### Les agents peuvent-ils travailler en dehors du workspace ?

Oui. Le workspace est le **cwd par défaut** et ancre mémoire, pas un sandbox dur.
Les chemins relatifs se résolvent dans le workspace, mais les chemins absolus peuvent accéder à d'autres emplacements hôte sauf si le sandboxing est activé. Si vous avez besoin d'isolation, utilisez [`agents.defaults.sandbox`](/fr-FR/gateway/sandboxing) ou paramètres sandbox par agent. Si vous voulez qu'un dépôt soit le répertoire de travail par défaut, pointez le `workspace` de cet agent vers la racine du dépôt. Le dépôt OpenClaw est juste du code source ; gardez le workspace séparé sauf si vous voulez intentionnellement que l'agent y travaille.

Exemple (dépôt comme cwd par défaut) :

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### Je suis en mode distant - où est le magasin de sessions ?

L'état de session appartient à **l'hôte passerelle**. Si vous êtes en mode distant, le magasin de sessions qui vous intéresse est sur la machine distante, pas votre laptop local. Voir [Gestion de session](/fr-FR/concepts/session).

## Bases de configuration

### Quel est le format de la config ? Où est-elle ?

OpenClaw lit une config **JSON5** optionnelle depuis `$OPENCLAW_CONFIG_PATH` (par défaut : `~/.openclaw/openclaw.json`) :

```
$OPENCLAW_CONFIG_PATH
```

Si le fichier manque, il utilise des défauts assez sûrs (incluant un workspace par défaut de `~/.openclaw/workspace`).

### J'ai défini gateway.bind: "lan" ou "tailnet" et maintenant rien n'écoute / l'UI dit unauthorized

Les liaisons non-loopback **nécessitent auth**. Configurez `gateway.auth.mode` + `gateway.auth.token` (ou utilisez `OPENCLAW_GATEWAY_TOKEN`).

```json5
{
  gateway: {
    bind: "lan",
    auth: {
      mode: "token",
      token: "remplacez-moi",
    },
  },
}
```

Notes :

- `gateway.remote.token` est pour **appels CLI distants** uniquement ; il n'active pas l'auth passerelle locale.
- L'UI de contrôle s'authentifie via `connect.params.auth.token` (stocké dans paramètres app/UI). Évitez de mettre des tokens dans les URLs.

### Pourquoi ai-je besoin d'un token sur localhost maintenant ?

L'assistant génère un token passerelle par défaut (même sur loopback) donc **les clients WS locaux doivent s'authentifier**. Cela bloque les autres processus locaux d'appeler la Passerelle. Collez le token dans les paramètres de l'UI de contrôle (ou votre config client) pour vous connecter.

Si vous voulez **vraiment** un loopback ouvert, supprimez `gateway.auth` de votre config. Doctor peut générer un token pour vous à tout moment : `openclaw doctor --generate-gateway-token`.

### Dois-je redémarrer après avoir changé la config ?

La Passerelle surveille la config et supporte le rechargement à chaud :

- `gateway.reload.mode: "hybrid"` (par défaut) : applique à chaud les changements sûrs, redémarre pour les critiques
- `hot`, `restart`, `off` sont aussi supportés

### Comment activer la recherche web (et web fetch) ?

`web_fetch` fonctionne sans clé API. `web_search` nécessite une clé API Brave Search. **Recommandé :** exécutez `openclaw configure --section web` pour la stocker dans `tools.web.search.apiKey`. Alternative environnement : définissez `BRAVE_API_KEY` pour le processus Passerelle.

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
      },
      fetch: {
        enabled: true,
      },
    },
  },
}
```

Notes :

- Si vous utilisez des listes autorisées, ajoutez `web_search`/`web_fetch` ou `group:web`.
- `web_fetch` est activé par défaut (sauf si explicitement désactivé).
- Les daemons lisent les vars env depuis `~/.openclaw/.env` (ou l'environnement service).

Docs : [Outils web](/fr-FR/tools/web).

### config.apply a effacé ma config. Comment récupérer et éviter ça ?

`config.apply` remplace **toute la config**. Si vous envoyez un objet partiel, tout le reste est supprimé.

Récupération :

- Restaurez depuis une sauvegarde (git ou une `~/.openclaw/openclaw.json` copiée).
- Si vous n'avez pas de sauvegarde, réexécutez `openclaw doctor` et reconfigurez canaux/modèles.
- Si c'était inattendu, déposez un bug et incluez votre dernière config connue ou toute sauvegarde.
- Un agent de codage local peut souvent reconstruire une config fonctionnelle depuis les journaux ou historique.

Évitez-le :

- Utilisez `openclaw config set` pour petits changements.
- Utilisez `openclaw configure` pour éditions interactives.

Docs : [Config](/fr-FR/cli/config), [Configure](/fr-FR/cli/configure), [Doctor](/fr-FR/gateway/doctor).

### Quelle est une config minimale saine pour une première installation ?

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Cela définit votre workspace et restreint qui peut déclencher le bot.

### Comment exécuter une Passerelle centrale avec des workers spécialisés sur différents appareils ?

Le modèle courant est **une Passerelle** (ex. Raspberry Pi) plus **nœuds** et **agents** :

- **Passerelle (centrale) :** possède les canaux (Signal/WhatsApp), routage et sessions.
- **Nœuds (appareils) :** Macs/iOS/Android se connectent comme périphériques et exposent des outils locaux (`system.run`, `canvas`, `camera`).
- **Agents (workers) :** cerveaux/workspaces séparés pour rôles spéciaux (ex. "ops Hetzner", "Données personnelles").
- **Sous-agents :** génèrent du travail d'arrière-plan depuis un agent principal quand vous voulez du parallélisme.
- **TUI :** connectez-vous à la Passerelle et changez agents/sessions.

Docs : [Nœuds](/fr-FR/nodes), [Accès distant](/fr-FR/gateway/remote), [Routage multi-agent](/fr-FR/concepts/multi-agent), [Sous-agents](/fr-FR/tools/subagents), [TUI](/fr-FR/web/tui).

### Le navigateur OpenClaw peut-il fonctionner headless ?

Oui. C'est une option de config :

```json5
{
  browser: { headless: true },
  agents: {
    defaults: {
      sandbox: { browser: { headless: true } },
    },
  },
}
```

Par défaut c'est `false` (avec tête). Headless est plus susceptible de déclencher des vérifications anti-bot sur certains sites. Voir [Navigateur](/fr-FR/tools/browser).

Headless utilise le **même moteur Chromium** et fonctionne pour la plupart des automatisations (formulaires, clics, scraping, logins). Les principales différences :

- Pas de fenêtre navigateur visible (utilisez des captures d'écran si vous avez besoin de visuels).
- Certains sites sont plus stricts sur l'automatisation en mode headless (CAPTCHAs, anti-bot).
  Par exemple, X/Twitter bloque souvent les sessions headless.

### Comment utiliser Brave pour le contrôle navigateur ?

Définissez `browser.executablePath` vers votre binaire Brave (ou tout navigateur basé Chromium) et redémarrez la Passerelle.
Voir les exemples de config complets dans [Navigateur](/fr-FR/tools/browser#use-brave-or-another-chromium-based-browser).

## Passerelles distantes et nœuds

### Comment les commandes se propagent-elles entre Telegram, la passerelle et les nœuds ?

Les messages Telegram sont gérés par la **passerelle**. La passerelle exécute l'agent et seulement alors appelle les nœuds via le **WebSocket Passerelle** quand un outil nœud est nécessaire :

Telegram → Passerelle → Agent → `node.*` → Nœud → Passerelle → Telegram

Les nœuds ne voient pas le trafic fournisseur entrant ; ils reçoivent uniquement des appels RPC nœud.

### Comment mon agent peut-il accéder à mon ordinateur si la Passerelle est hébergée à distance ?

Réponse courte : **appairez votre ordinateur comme nœud**. La Passerelle fonctionne ailleurs, mais elle peut appeler des outils `node.*` (écran, caméra, système) sur votre machine locale via le WebSocket Passerelle.

Configuration typique :

1. Exécutez la Passerelle sur l'hôte toujours actif (VPS/serveur maison).
2. Mettez l'hôte Passerelle + votre ordinateur sur le même tailnet.
3. Assurez-vous que le WS Passerelle est accessible (liaison tailnet ou tunnel SSH).
4. Ouvrez l'app macOS localement et connectez-vous en mode **Remote over SSH** (ou tailnet direct) pour qu'elle puisse s'enregistrer comme nœud.
5. Approuvez le nœud sur la Passerelle :

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Aucun pont TCP séparé n'est requis ; les nœuds se connectent via le WebSocket Passerelle.

Rappel de sécurité : appairer un nœud macOS autorise `system.run` sur cette machine. N'appairez que les appareils de confiance, et examinez [Sécurité](/fr-FR/gateway/security).

Docs : [Nœuds](/fr-FR/nodes), [Protocole passerelle](/fr-FR/gateway/protocol), [Mode distant macOS](/fr-FR/platforms/mac/remote), [Sécurité](/fr-FR/gateway/security).

### Tailscale est connecté mais je n'obtiens pas de réponses. Que faire ?

Vérifiez les bases :

- La passerelle fonctionne : `openclaw gateway status`
- Santé passerelle : `openclaw status`
- Santé canal : `openclaw channels status`

Puis vérifiez auth et routage :

- Si vous utilisez Tailscale Serve, assurez-vous que `gateway.auth.allowTailscale` est correctement défini.
- Si vous vous connectez via tunnel SSH, confirmez que le tunnel local est actif et pointe vers le bon port.
- Confirmez que vos listes autorisées (DM ou groupe) incluent votre compte.

Docs : [Tailscale](/fr-FR/gateway/tailscale), [Accès distant](/fr-FR/gateway/remote), [Canaux](/fr-FR/channels).

### Deux instances OpenClaw peuvent-elles se parler (local + VPS) ?

Oui. Il n'y a pas de pont "bot-à-bot" intégré, mais vous pouvez le câbler de quelques manières fiables :

**Le plus simple :** utilisez un canal de chat normal auquel les deux bots peuvent accéder (Telegram/Slack/WhatsApp).
Faites envoyer au Bot A un message au Bot B, puis laissez le Bot B répondre normalement.

**Pont CLI (générique) :** exécutez un script qui appelle l'autre Passerelle avec `openclaw agent --message ... --deliver`, ciblant un chat où l'autre bot écoute. Si un bot est sur un VPS distant, pointez votre CLI vers cette Passerelle distante via SSH/Tailscale (voir [Accès distant](/fr-FR/gateway/remote)).

Exemple de modèle (exécuté depuis une machine qui peut atteindre la Passerelle cible) :

```bash
openclaw agent --message "Bonjour depuis le bot local" --deliver --channel telegram --reply-to <chat-id>
```

Conseil : ajoutez un garde-fou pour que les deux bots ne bouclent pas indéfiniment (mention uniquement, listes autorisées canal, ou une règle "ne pas répondre aux messages bot").

Docs : [Accès distant](/fr-FR/gateway/remote), [CLI Agent](/fr-FR/cli/agent), [Envoi agent](/fr-FR/tools/agent-send).

### Ai-je besoin de VPS séparés pour plusieurs agents ?

Non. Une Passerelle peut héberger plusieurs agents, chacun avec son propre workspace, défauts modèle et routage. C'est la configuration normale et c'est beaucoup moins cher et plus simple qu'exécuter un VPS par agent.

Utilisez des VPS séparés uniquement quand vous avez besoin d'une isolation dure (frontières de sécurité) ou de configs très différentes que vous ne voulez pas partager. Sinon, gardez une Passerelle et utilisez plusieurs agents ou sous-agents.

### Y a-t-il un avantage à utiliser un nœud sur mon laptop personnel au lieu de SSH depuis un VPS ?

Oui - les nœuds sont le moyen de première classe pour atteindre votre laptop depuis une Passerelle distante, et ils déverrouillent plus que l'accès shell. La Passerelle fonctionne sur macOS/Linux (Windows via WSL2) et est légère (un petit VPS ou boîtier classe Raspberry Pi suffit ; 4 GB RAM c'est beaucoup), donc une configuration courante est un hôte toujours actif plus votre laptop comme nœud.

- **Pas de SSH entrant requis.** Les nœuds se connectent au WebSocket Passerelle et utilisent l'appairage d'appareil.
- **Contrôles d'exécution plus sûrs.** `system.run` est bloqué par listes autorisées/approbations nœud sur ce laptop.
- **Plus d'outils appareil.** Les nœuds exposent `canvas`, `camera` et `screen` en plus de `system.run`.
- **Automatisation navigateur local.** Gardez la Passerelle sur un VPS, mais exécutez Chrome localement et relayez le contrôle avec l'extension Chrome + un hôte nœud sur le laptop.

SSH est bien pour accès shell ad-hoc, mais les nœuds sont plus simples pour workflows agent continus et automatisation appareil.

Docs : [Nœuds](/fr-FR/nodes), [CLI Nœuds](/fr-FR/cli/nodes), [Extension Chrome](/fr-FR/tools/chrome-extension).

### Devrais-je installer sur un second laptop ou juste ajouter un nœud ?

Si vous avez seulement besoin d'**outils locaux** (écran/caméra/exec) sur le second laptop, ajoutez-le comme **nœud**. Cela garde une seule Passerelle et évite la config dupliquée. Les outils nœud locaux sont actuellement macOS uniquement, mais nous prévoyons de les étendre à d'autres OS.

Installez une seconde Passerelle uniquement quand vous avez besoin d'**isolation dure** ou deux bots complètement séparés.

Docs : [Nœuds](/fr-FR/nodes), [CLI Nœuds](/fr-FR/cli/nodes), [Passerelles multiples](/fr-FR/gateway/multiple-gateways).

### Les nœuds exécutent-ils un service passerelle ?

Non. Seule **une passerelle** devrait fonctionner par hôte sauf si vous exécutez intentionnellement des profils isolés (voir [Passerelles multiples](/fr-FR/gateway/multiple-gateways)). Les nœuds sont des périphériques qui se connectent à la passerelle (nœuds iOS/Android, ou "mode nœud" macOS dans l'app menubar). Pour hôtes nœud headless et contrôle CLI, voir [CLI hôte nœud](/fr-FR/cli/node).

Un redémarrage complet est requis pour les changements `gateway`, `discovery` et `canvasHost`.

### Y a-t-il un moyen API / RPC d'appliquer la config ?

Oui. `config.apply` valide + écrit toute la config et redémarre la Passerelle dans l'opération.

### Comment configurer Tailscale sur un VPS et me connecter depuis mon Mac ?

Étapes minimales :

1. **Installez + connectez-vous sur le VPS**

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. **Installez + connectez-vous sur votre Mac**
   - Utilisez l'app Tailscale et connectez-vous au même tailnet.
3. **Activez MagicDNS (recommandé)**
   - Dans la console admin Tailscale, activez MagicDNS pour que le VPS ait un nom stable.
4. **Utilisez le nom d'hôte tailnet**
   - SSH : `ssh user@your-vps.tailnet-xxxx.ts.net`
   - WS Passerelle : `ws://your-vps.tailnet-xxxx.ts.net:18789`

Si vous voulez l'UI de contrôle sans SSH, utilisez Tailscale Serve sur le VPS :

```bash
openclaw gateway --tailscale serve
```

Cela garde la passerelle liée au loopback et expose HTTPS via Tailscale. Voir [Tailscale](/fr-FR/gateway/tailscale).

### Comment connecter un nœud Mac à une Passerelle distante (Tailscale Serve) ?

Serve expose **l'UI de contrôle Passerelle + WS**. Les nœuds se connectent via le même point de terminaison WS Passerelle.

Configuration recommandée :

1. **Assurez-vous que le VPS + Mac sont sur le même tailnet**.
2. **Utilisez l'app macOS en mode Remote** (la cible SSH peut être le nom d'hôte tailnet).
   L'app va tunneliser le port Passerelle et se connecter comme nœud.
3. **Approuvez le nœud** sur la passerelle :

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Docs : [Protocole passerelle](/fr-FR/gateway/protocol), [Découverte](/fr-FR/gateway/discovery), [Mode distant macOS](/fr-FR/platforms/mac/remote).

## Variables d'environnement et chargement .env

### D'où viennent les secrets ? Comment définir les clés API ?

Variables d'environnement ou config directement. OpenClaw charge `~/.openclaw/.env` automatiquement quand un daemon démarre, donc c'est le meilleur endroit pour les secrets partagés.

Les secrets fournisseur (clés OAuth API, tokens Slack, etc.) sont aussi stockés dans `~/.openclaw/credentials/`, créés pendant `openclaw configure` ou `openclaw login`.

Voir [Variables d'environnement](/fr-FR/help/environment).

### Pourquoi .env n'est-il pas chargé après le redémarrage du service / service systemd ?

Parce que les unités systemd s'exécutent dans une session propre sans login shell et OpenClaw charge `.env` **uniquement depuis l'environnement du processus Passerelle**, pas votre shell utilisateur distant.

La solution officielle est de **définir vars dans la définition service** :

```ini
[Service]
Environment="ANTHROPIC_API_KEY=..."
Environment="OPENAI_API_KEY=..."
EnvironmentFile=/home/youruser/.openclaw/.env
```

Ou utilisez `ExecStartPre` pour un script source-and-exec.

Pourquoi c'est comme ça :

- **Vars Daemon diffèrent du shell.** Systemd/launchd/runit/etc. n'héritent pas de votre `~/.bashrc`.
- **Cohérence shell.** La Passerelle n'est pas un "shell executor" - elle ne peut pas deviner quel profil shell l'utilisateur veut.
- **Sécurité.** Des vars limitées au service réduisent la surface d'exposition.

### Comment gérer plusieurs environnements (staging, prod) avec des clés API différentes ?

**Utilisez plusieurs Passerelles** ou **variables d'environnement externes**. OpenClaw ne supporte pas les fichiers `.env.staging` / `.env.prod` dans la même instance, et nous ne recommandons pas de définir plusieurs Passerelles sur un seul hôte sauf configuration très avancée (voir [Passerelles multiples](/fr-FR/gateway/multiple-gateways)).

Alternatives propres :

- Hôtes séparés (ex. VPS staging, VPS prod).
- Gestion env runtime via le gestionnaire service et profils (les définitions systemd varient déjà les vars par service).
- Scripts wrapper qui définissent `OPENCLAW_CONFIG_PATH` et lancent des profils isolés.

Docs : [Passerelles multiples](/fr-FR/gateway/multiple-gateways).

### Pourquoi le shell de la Passerelle ne voit-il pas mes vars ?

Parce que `system.run` (et autres shells) héritent uniquement des variables définies dans **l'environnement du processus Passerelle** :

- vars en ligne dans le démarrage Passerelle ou la définition service.
- vars dans `~/.openclaw/.env` (chargées par OpenClaw au démarrage).
- **Pas** de votre shell personnel, tmux, ou profil SSH.

Workflow suggéré :

- Gardez les secrets dans `~/.openclaw/.env`.
- Ajoutez des vars spécifiques hook dans `.env` aussi.
- Ou passez des env via la commande hook (`env FOO=val bash...`).

Cas limite : si vous lancez la Passerelle **depuis un shell interactif** (ex. via tmux), elle héritera de cette session, mais ce n'est pas le cas courant ni recommandé pour daemons.

Docs : [Variables d'environnement](/fr-FR/help/environment).

### Mon utilisateur zsh a des vars définies, mais l'agent ne peut pas les voir dans system.run

Comportement attendu. `system.run` hérite du **processus Passerelle**, pas de votre fichier de profil zsh. Corriger :

- Définissez les vars dans `~/.openclaw/.env` (elles seront chargées dans la Passerelle).
- Ou définissez-les dans la définition de service daemon si vous utilisez systemd/launchd.

Vous ne pouvez pas "hériter depuis zsh" car l'agent ne démarre pas un zsh login shell ; il exécute `bash -c` par défaut (configurable via `agents.*.sandbox.shell`).

## Sessions et chats multiples

### Qu'est-ce qu'une session ?

Une **session** est un agent + un fil de conversation unique. Chaque session a son propre historique de messages, arbre de contexte, et espace de travail (le répertoire de fichiers de l'agent).

Vous pouvez avoir **plusieurs sessions** pour le même agent (ils partagent la config mais ont des historiques de conversation séparés).

Docs : [Sessions](/fr-FR/concepts/sessions), [Concepts de session](/fr-FR/concepts/session).

### Si je contacte le bot depuis WhatsApp et Telegram simultanément, sont-elles la même session ?

**Non.** Chaque canal obtient un identifiant utilisateur unique, donc l'agent traite WhatsApp DM et Telegram DM comme des sessions séparées. Si vous voulez une session partagée entre canaux, vous avez besoin de routage de session personnalisé ou un modèle d'envoi explicite.

Voir [Multisession](/fr-FR/concepts/sessions#sessions-multiples).

### Puis-je avoir deux agents simultanés dans le même chat ?

Oui, **exactement le modèle multi-agent d'OpenClaw**. Un agent peut générer des sous-agents, ou vous pouvez manuellement marquer un autre agent pour les messages entrants.

Docs : [Multi-agent](/fr-FR/concepts/multi-agent).

### Comment démarrer une session fraîche ? Comment ai-je trop de contexte ?

Utilisez `/reset` ou `openclaw agents reset` dans l'UI de contrôle. Ou utilisez des [filtres de session](/fr-FR/concepts/session-pruning) pour tronquer ou archiver les vieux messages.

Un "trop de contexte" peut survenir quand vous approchez de la fenêtre contextuelle du modèle. OpenClaw garde automatiquement de la place pour la sortie modèle, mais vous pouvez toujours générer une session dense avec beaucoup d'historique.

Docs : [Compaction](/fr-FR/concepts/compaction), [Élagage de session](/fr-FR/concepts/session-pruning).

### Comment changer d'agent à mi-fil ?

Dépend du canal. L'UI de contrôle a un sélecteur d'agent. Pour Telegram/WhatsApp, le bot détecte normalement un switch basé sur de nouvelles demandes via `agents.routing` ou le routage par défaut.

Si rien n'est configuré, c'est difficile de changer à mi-conversation - considérez `/reset` et redémarrer avec votre nouvel agent sélectionné. Ou utilisez l'UI de contrôle où le switch est explicite.

Docs : [Agents](/fr-FR/concepts/agent), [Multi-agent](/fr-FR/concepts/multi-agent).

### Puis-je avoir des sessions séparées pour des tâches différentes avec le même agent ?

Oui. **Une approche** est d'ouvrir des fils séparés sur le même agent ou d'utiliser l'UI de contrôle pour jongler plusieurs onglets session. Une **seconde approche** est de créer plusieurs agents avec la même config mais différents workspaces. Ensuite utilisez `session.ttl` ou réinitialisations manuelles pour cycler.

Docs : [Sessions multiples](/fr-FR/concepts/sessions#sessions-multiples).

### Puis-je "sauvegarder" et "charger" mes fils de conversation ?

En partie. Vos sessions persistent dans `sessions/` jusqu'à élagage ou destruction. Pour un vrai export, clonez le répertoire `sessions/<agentId>` avec tous les fichiers JSONL associés. Pour re-charger dans une nouvelle Passerelle, collez-les.

OpenClaw n'exporte/importe pas encore les bundles de session proprement de manière first-class (c'est une fonctionnalité future). Actuellement : sauvegardez à la main les fichiers JSONL et workspace.

Voir [Outil de session](/fr-FR/concepts/session-tool).

### Les sessions sont-elles partagées entre nœuds ?

**Non.** Les sessions appartiennent à la Passerelle. Les nœuds exécutent seulement des outils quand la Passerelle les appelle. Si vous voulez une session multi-appareil, gardez une Passerelle centrale et faites s'y connecter tous vos appareils comme nœuds.

### Combien de sessions puis-je avoir ?

Illimité tant que vous avez de l'espace disque. Le coût réel est dans vos tokens modèle. Gardez à l'esprit que `session.ttl` ou `session.pruning` peuvent limiter l'âge de session ou supprimer les vieilles sessions automatiquement.

Docs : [Élagage de session](/fr-FR/concepts/session-pruning).

## Modèles : défauts, sélection, alias, changement

### Quels modèles sont supportés ?

OpenClaw supporte tous les fournisseurs majeurs LLM : OpenAI, Anthropic, Google Gemini, et plus via [LiteLLM](/fr-FR/providers/litellm) pour 100+ autres (Ollama local, Groq, Mistral, Cohere, etc.).

**Fournisseurs first-class** (avec routes API officielles) :

- OpenAI (GPT-4o, GPT-4o mini, GPT-o1, o3-mini, GPT-4 Turbo)
- Anthropic (Claude 3.5 Sonnet, 3.7 Opus, 3 Haiku)
- Google (Gemini 1.5 Pro, Gemini 2.0 Flash)
- xAI (Grok 2)

**Via LiteLLM** (tous les 100+ modèles sur litellm.ai/providers) :

- Modèles locaux : Ollama, vLLM, Hugging Face
- Fournisseurs cloud : Mistral, Cohere, Together AI, Replicate, Groq, Cerebras, etc.

Docs : [Providers](/fr-FR/providers), [Modèles](/fr-FR/concepts/models), [Configuration modèle](/fr-FR/cli/configure#models).

### Comment définir un modèle par défaut ?

Utilisez `models.defaults.model` dans votre config. Exemple :

```json5
{
  models: {
    defaults: { model: "anthropic/claude-3-5-sonnet-20250219" },
  },
}
```

Pour changements à chaud, exécutez :

```bash
openclaw config set models.defaults.model "anthropic/claude-3-5-sonnet-20250219"
```

Voir [Providers modèles](/fr-FR/concepts/model-providers).

### Comment spécifier un modèle pour un seul message ?

Utilisez `/model <nom_modèle>` dans le chat ou passez `--model` au CLI.

Exemples :

```
/model gpt-4o
/model anthropic/claude-3-5-sonnet-20250219
```

CLI :

```bash
openclaw agent --message "Explique les qubits" --model openai/gpt-4o
```

Docs : [Modèles](/fr-FR/concepts/models).

### Puis-je utiliser un modèle différent pour chaque agent ?

Oui. Chaque agent peut avoir son propre `model` par défaut dans `agents.<agentId>.defaults.model` :

```json5
{
  agents: {
    mybot: {
      defaults: { model: "openai/gpt-4o" },
    },
    expert: {
      defaults: { model: "anthropic/claude-3-7-opus-20250219" },
    },
  },
}
```

Docs : [Config agents](/fr-FR/cli/configure#agents).

### Comment définir des alias de modèles ?

Utilisez `models.aliases` :

```json5
{
  models: {
    aliases: {
      fast: "openai/gpt-4o-mini",
      smart: "anthropic/claude-3-5-sonnet-20250219",
      local: "ollama/llama3.2",
    },
  },
}
```

Maintenant vous pouvez envoyer `/model fast` dans le chat ou passer `--model fast` au CLI.

Docs : [Alias de modèles](/fr-FR/concepts/models#aliases-de-modèles).

### Puis-je basculer entre les fournisseurs modèles dynamiquement sans redémarrer ?

Oui. Les commandes `/model <nom>` et `openclaw config set models.defaults.model` prennent effet immédiatement. Aucun redémarrage requis.

### Comment utiliser Ollama avec OpenClaw ?

Deux options :

1. **Ollama natif (préféré)** : activez le fournisseur Ollama avec `openclaw configure --section models` et définissez les modèles via noms ollama :

```json5
{
  models: {
    providers: {
      ollama: { enabled: true, baseUrl: "http://localhost:11434" },
    },
    defaults: { model: "ollama/llama3.2" },
  },
}
```

2. **Via LiteLLM** : activez LiteLLM et utilisez `litellm/ollama/llama3.2`. Docs : [Provider Ollama](/fr-FR/providers/ollama), [LiteLLM](/fr-FR/providers/litellm).

### Est-ce qu'OpenClaw fonctionne complètement offline avec Ollama ?

Oui, **si** vous désactivez `web_search` et tous les fournisseurs externes. Le fonctionnement d'OpenClaw local peut être à 100% offline avec Ollama + aucune clé API externe.

Désactivez la recherche web :

```json5
{
  tools: {
    web: {
      search: { enabled: false },
      fetch: { enabled: false },
    },
  },
}
```

Docs : [Ollama](/fr-FR/providers/ollama), [Opération offline](/fr-FR/start/getting-started#fonctionnement-offline-local).

### Quel est le modèle d'entrée de gamme le moins cher avec qualité décente ?

**GPT-4o-mini** et **Claude 3 Haiku** sont rapides, bon marché et étonnamment capables. Pour ultra local/gratuit, **Llama 3.2 via Ollama** fonctionne bien.

Voir [Modèles](/fr-FR/concepts/models), [Sélection de modèle](/fr-FR/concepts/models#sélection-de-modèle).

### Comment changer de modèle par défaut pour tous les agents à la fois ?

Définissez `models.defaults.model` globalement. Tous les agents sans override `defaults.model` hériteront de ce global.

```bash
openclaw config set models.defaults.model "anthropic/claude-3-5-sonnet-20250219"
```

Ou éditez la config :

```json5
{
  models: {
    defaults: { model: "anthropic/claude-3-5-sonnet-20250219" },
  },
}
```

### J'ai défini un nouveau modèle dans la config mais il ne s'affiche pas

Assurez-vous que le fournisseur (OpenAI, Anthropic, Google, etc.) est **activé** dans `models.providers.<nom>.enabled`. Si le fournisseur manque ou est désactivé, la passerelle ignore ses modèles.

Docs : [Configuration modèle](/fr-FR/cli/configure#models).

## Basculement (failover) de modèle

### Qu'est-ce que le basculement de modèle ?

Le failover modèle est une liste ordonnée de modèles. Si le premier modèle échoue (limite de taux, panne, etc.), OpenClaw essaie automatiquement les modèles suivants.

Config :

```json5
{
  models: {
    failover: {
      enabled: true,
      models: [
        "anthropic/claude-3-5-sonnet-20250219",
        "openai/gpt-4o",
        "google/gemini-2.0-flash-exp",
      ],
    },
  },
}
```

**Comportement :** si Claude échoue, essayez GPT-4o ; s'il échoue, essayez Gemini 2.0 Flash. Si tous échouent, l'agent renvoie une erreur.

Docs : [Failover de modèle](/fr-FR/concepts/model-failover).

### Puis-je définir un failover par agent ?

Oui. Overridez `models.failover` dans `agents.<agentId>` :

```json5
{
  agents: {
    reliable: {
      defaults: {
        model: "anthropic/claude-3-5-sonnet-20250219",
      },
      models: {
        failover: {
          enabled: true,
          models: ["openai/gpt-4o", "google/gemini-2.0-flash-exp"],
        },
      },
    },
  },
}
```

Le failover fonctionne uniquement si le modèle principal échoue (erreur API 5xx, timeout, limite de taux). Il n'active pas sur un refus de modèle ou erreur utilisateur.

Docs : [Failover de modèle](/fr-FR/concepts/model-failover).

### Le failover coûte-t-il des appels API supplémentaires ?

Seulement quand le premier modèle échoue. Aucun coût supplémentaire si votre premier modèle réussit.

### Comment forcer un failover pour tester ma config ?

Utilisez un faux modèle en tant que primaire :

```json5
{
  models: {
    defaults: { model: "openai/gpt-nonexistent" },
    failover: {
      enabled: true,
      models: ["openai/gpt-4o"],
    },
  },
}
```

Le premier appel échouera, et OpenClaw basculera vers `gpt-4o`.

## Profils d'auth

### Qu'est-ce qu'un profil d'auth ?

Un **profil d'auth** est un ensemble nommé de credentials (clés API, tokens OAuth, etc.) pour un fournisseur. Cela vous permet de permuter entre plusieurs comptes ou clés pour le même service.

Créez-les via `openclaw configure` ou `openclaw login`. Docs : [Configuration](/fr-FR/cli/configure), [Auth fournisseur](/fr-FR/concepts/oauth).

### Quand ai-je besoin de plusieurs profils ?

- Comptes personnels vs. professionnels.
- Limites de taux par clé (rotation).
- Environnements staging/prod avec credentials différents.

### Puis-je partager le même profil entre agents ?

Oui. Les profils sont globaux au niveau de la Passerelle. Tous les agents peuvent utiliser n'importe quel profil à moins de contraintes explicites.

### Comment changer le profil actif pour un fournisseur ?

Exécutez `openclaw configure --section models` et sélectionnez le profil désiré pour le fournisseur. Ou éditez `models.providers.<provider>.profile` directement.

Docs : [Configuration modèle](/fr-FR/cli/configure#models), [Providers](/fr-FR/providers).

## Passerelle : ports, "already running", mode distant

### Quel port utilise la Passerelle ?

Port par défaut : `18789` (WebSocket + API HTTP).

Configurable via `gateway.port` ou `OPENCLAW_GATEWAY_PORT`.

Docs : [Protocole passerelle](/fr-FR/gateway/protocol).

### Pourquoi obtiens-je "Address already in use" ou "Gateway already running" ?

Causes courantes :

- Une autre instance de passerelle fonctionne déjà.
- Un ancien processus daemon n'a pas nettoyé.
- Un autre service utilise le port 18789.

Corrections :

1. Arrêtez l'ancienne passerelle : `openclaw gateway stop` (ou tuez le PID si nécessaire).
2. Vérifiez les processus en cours d'exécution :
   - macOS/Linux : `lsof -i :18789` ou `ss -ltnp | grep 18789`
   - Windows : `netstat -ano | findstr 18789`
3. Changez le port si nécessaire : `gateway.port: 18790`.

### Puis-je exécuter plusieurs passerelles sur le même hôte ?

Oui, mais cela nécessite une **configuration avancée** : différents répertoires config, différents ports, services isolés. Voir [Passerelles multiples](/fr-FR/gateway/multiple-gateways).

Usage normal : une passerelle, plusieurs agents.

### Qu'est-ce que le mode distant de la Passerelle ?

Le mode distant signifie que votre **CLI ou UI** se connecte à une passerelle s'exécutant sur un hôte distant (VPS, Raspberry Pi, etc.) au lieu de localhost.

Configurez via `openclaw configure --section gateway` ou définissez manuellement `gateway.remote` :

```json5
{
  gateway: {
    remote: {
      enabled: true,
      host: "your-vps.example.com",
      port: 18789,
      token: "your-gateway-token",
    },
  },
}
```

Le CLI tunnelise automatiquement via SSH si SSH est configuré.

Docs : [Accès distant](/fr-FR/gateway/remote), [Mode distant macOS](/fr-FR/platforms/mac/remote).

### Puis-je utiliser HTTPS pour la passerelle ?

La passerelle elle-même ne gère pas TLS directement. Utilisez **un proxy inverse** (nginx, Caddy, Tailscale Serve) devant elle :

- **Tailscale Serve** : intégré, certifiés automatiques, liaison loopback uniquement (recommandé).
- **nginx/Caddy** : reverse proxy sur VPS public avec Let's Encrypt.

### Comment redémarrer la passerelle ?

Dépend de votre système :

- **macOS app** : Menu → Redémarrer Passerelle
- **CLI** : `openclaw gateway restart` (ou `stop` puis `run`)
- **Systemd** : `sudo systemctl restart openclaw-gateway`
- **macOS menubar (daemon)** : `scripts/restart-mac.sh` ou utilisez l'app

### La passerelle peut-elle gérer plusieurs canaux simultanément ?

Oui. C'est le **modèle central** d'OpenClaw. Une passerelle peut gérer Telegram, WhatsApp, Signal, Slack, Discord, etc., tous en même temps et router les messages entrants vers les agents appropriés.

### J'ai défini gateway.bind: "lan" mais cURL échoue toujours. Pourquoi ?

Vérifiez que :

- `gateway.auth` est correctement défini (token ou OAuth).
- Votre pare-feu autorise le port 18789.
- Vous ciblez la bonne interface réseau LAN.

Test :

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" http://<lan-ip>:18789/api/health
```

## Journalisation et débogage

### Où sont les journaux de la passerelle ?

**macOS (menubar app)** :

- Journaux système (via unified logging) : utilisez `scripts/clawlog.sh` ou Console.app
- Journaux daemon : `~/Library/Logs/OpenClaw/`

**Linux (systemd)** :

```bash
sudo journalctl -u openclaw-gateway -f
```

**Exécution manuelle** :

- Par défaut : stdout/stderr
- Config : `logging.file` pour journalisation fichier

### Comment activer les journaux de débogage ?

Définissez `logging.level: "debug"` dans la config ou définissez `OPENCLAW_LOG_LEVEL=debug` :

```json5
{
  logging: {
    level: "debug",
  },
}
```

Ou via env :

```bash
OPENCLAW_LOG_LEVEL=debug openclaw gateway run
```

### Comment déboguer les échecs de connexion LLM ?

Activez `logging.level: "debug"` et vérifiez les journaux pour les erreurs API. Vérifiez également :

- Les clés API sont correctes et activées.
- Les limites de taux fournisseur.
- Le basculement modèle si un fournisseur est en panne.

Docs : [Débogage](/fr-FR/help/debugging), [Modèles](/fr-FR/concepts/models), [Failover](/fr-FR/concepts/model-failover).

### Puis-je journaliser toutes les demandes/réponses LLM ?

Oui. Activez `logging.verboseModels: true` pour journaliser les charges utiles complètes API (avertissement : cela peut inclure des informations sensibles) :

```json5
{
  logging: {
    verboseModels: true,
  },
}
```

Docs : [Journalisation](/fr-FR/logging).

### Y a-t-il un dashboard de surveillance ?

Pas encore. Actuellement :

- **CLI** : `openclaw status --deep`, `openclaw channels status --probe`, `openclaw agents status`
- **UI de contrôle** : vérifications de santé, liste de canaux, liste d'agents
- **Journaux** : systemd journalctl, unified logging macOS, ou logs fichier

Monitoring avancé (Prometheus, Grafana) n'est pas encore intégré mais peut être ajouté via des hooks personnalisés.

Docs : [Status](/fr-FR/cli/status), [Channels status](/fr-FR/cli/channels#status).

### Les journaux de session sont-ils conservés après reset ?

**Non**. `openclaw agents reset` supprime l'historique de conversation de cette session. Si vous voulez archiver, sauvegardez `~/.openclaw/agents/<agentId>/sessions/*.jsonl` avant le reset.

Docs : [Élagage de session](/fr-FR/concepts/session-pruning), [Outil de session](/fr-FR/concepts/session-tool).

## Médias et pièces jointes

### Comment envoyer des fichiers à l'agent ?

Dépend du canal :

- **Telegram/WhatsApp/Signal** : envoyez simplement l'image/PDF comme message. L'agent reçoit la pièce jointe + votre texte.
- **UI de contrôle** : bouton de téléchargement (si disponible dans cette version).
- **CLI** : utilisez `openclaw agent --message "..." --attach file.png`.

### L'agent peut-il générer des images ?

Oui. Utilisez `generate_image` (si DALL·E ou Stable Diffusion est configuré), ou demandez simplement "génère une image de..." et l'agent appellera l'outil approprié.

### Comment envoyer des vidéos ou de l'audio ?

La plupart des canaux supportent les pièces jointes vidéo/audio. L'agent peut les transcrire (via Whisper si configuré) ou les analyser (selon capacités du modèle).

### Les médias générés sont-ils enregistrés quelque part ?

Oui, dans le **workspace de l'agent** (`~/.openclaw/workspace/<agentId>/` par défaut). Les fichiers générés (images, PDFs, CSVs, etc.) persistent jusqu'à suppression manuelle ou nettoyage de workspace.

### Puis-je définir un répertoire de téléchargement personnalisé pour les fichiers générés ?

Oui. Définissez `agents.<agentId>.workspace` pour pointer vers un chemin personnalisé :

```json5
{
  agents: {
    mybot: {
      workspace: "/chemin/vers/stockage/personnalisé",
    },
  },
}
```

Docs : [Config agents](/fr-FR/cli/configure#agents), [Agent workspace](/fr-FR/concepts/agent-workspace).

### Comment l'agent gère-t-il les grandes pièces jointes ?

OpenClaw diffuse les pièces jointes et peut gérer des fichiers relativement volumineux (limité par les restrictions du canal et la config serveur). Pour des fichiers énormes (100+ MB), considérez les diviser ou utiliser le téléchargement direct de workspace.

## Sécurité et contrôle d'accès

### OpenClaw est-il sécurisé par défaut ?

**Oui** pour usage personnel en loopback. **Non** si vous l'exposez à Internet sans auth appropriée.

Bonnes pratiques :

- Gardez la passerelle liée à loopback (`gateway.bind: "loopback"`) sauf si nécessaire.
- Activez `gateway.auth` avec un token fort pour liaisons non-loopback.
- Utilisez des listes autorisées canal (`allowFrom`, `allowChannels`) pour restreindre qui peut contacter l'agent.
- N'exposez jamais la passerelle publiquement sans HTTPS + auth (utilisez Tailscale Serve ou un proxy inverse).

### Est-ce sûr de laisser l'agent gérer des DM depuis n'importe qui ?

**Non** à moins que vous n'ayez des listes autorisées strictes. Sans listes autorisées, n'importe qui peut déclencher l'exécution d'outils (incluant `system.run`), ce qui est un risque sérieux.

Définissez **toujours** `channels.<channel>.allowFrom` :

```json5
{
  channels: {
    telegram: {
      allowFrom: ["@votre_utilisateur", "123456789"],
    },
  },
}
```

Docs : [Listes autorisées canal](/fr-FR/channels#listes-autorisées), [Sécurité](/fr-FR/gateway/security).

### Comment empêcher l'injection de prompt ?

Il n'y a pas de défense parfaite, mais OpenClaw aide :

- Les **listes autorisées canal** bloquent les inconnus.
- **Approbations d'outils** (`requireApproval`) forcent la confirmation humaine avant exec/filesystem/navigateur.
- **Filtres de session** + compaction réduisent les historiques de contexte longs où l'injection se cache.

Le prompt système inclut aussi des instructions de base sur la confiance utilisateur.

### L'agent peut-il accéder à des fichiers hors de son workspace ?

**Oui**, si **autorisé par config**. Par défaut, `file.*` et `system.run` peuvent accéder au système de fichiers. Pour restreindre :

- Définissez `agents.<agentId>.sandbox.filesystem` pour limiter les chemins.
- Utilisez des listes autorisées d'outils pour désactiver `file.*` ou `system.run` entièrement.

### Est-ce que l'appairage de nœud nécessite l'approbation de l'utilisateur ?

**Oui**. Par défaut, les demandes d'appairage de nœud sont en attente jusqu'à ce que vous les approuviez via `openclaw nodes approve <requestId>`.

Docs : [Nœuds](/fr-FR/nodes), [CLI Nœuds](/fr-FR/cli/nodes).

### Puis-je auditer toutes les commandes exécutées par l'agent ?

Oui. Activez `logging.level: "debug"` ou `logging.verboseModels: true` pour journaliser tous les appels d'outils. Vous pouvez aussi écrire des hooks personnalisés (`onToolCall`, `onToolResult`) pour journalisation centralisée.

### Les credentials sont-ils stockés en sécurité ?

OpenClaw stocke les credentials dans `~/.openclaw/credentials/` et la config dans `~/.openclaw/openclaw.json` (JSON5). Les deux sont **en texte clair** sur le disque.

Protégez ces fichiers avec des permissions système (`chmod 600`) et considérez le chiffrement de disque complet. OpenClaw ne chiffre pas encore les credentials au repos de manière native (fonctionnalité future).

## Commandes de chat et interruption de tâches

### Comment annuler ou aborter une tâche en cours ?

Envoyez **"abort"** ou **"/abort"** dans le chat. L'agent tentera de tuer la tâche en cours et répondra.

### Puis-je envoyer plusieurs requêtes en parallèle ?

Oui si vous ouvrez **plusieurs sessions** ou utilisez des **sous-agents** (via l'outil `task`). Une seule session traite les messages séquentiellement par défaut.

Docs : [Sessions multiples](/fr-FR/concepts/sessions#sessions-multiples), [Sous-agents](/fr-FR/tools/subagents).

### Comment envoyer des messages cross-context (depuis un agent vers un autre canal) ?

Utilisez **`agent.send`** ou l'intégration CLI. Exemples :

**Dans l'agent (outil)** :

```typescript
await agent.send({
  channel: "telegram",
  user: "@votre_utilisateur",
  message: "Bonjour depuis l'agent A !",
});
```

**Depuis CLI** :

```bash
openclaw message send --channel telegram --user "@votre_utilisateur" --message "Bonjour !"
```

Docs : [Envoi agent](/fr-FR/tools/agent-send), [CLI Message](/fr-FR/cli/message).

### Y a-t-il un moyen de programmer des messages périodiques ?

Oui. Utilisez **cron hooks** :

```json5
{
  automation: {
    cron: {
      jobs: [
        {
          name: "Rapport quotidien",
          schedule: "0 9 * * *",
          command: "openclaw message send --channel telegram --user @moi --message 'Rapport quotidien'",
        },
      ],
    },
  },
}
```

Docs : [Cron jobs](/fr-FR/automation/cron-jobs).

### Puis-je déclencher l'agent depuis un webhook externe ?

Oui. Activez `automation.webhooks` et pointez votre service externe vers l'endpoint webhook. L'agent peut traiter la charge utile et répondre.

---

**Vous ne trouvez toujours pas votre réponse ?**

- Consultez la [Documentation complète](/fr-FR/start/getting-started)
- Cherchez des problèmes sur [GitHub](https://github.com/openclaw/openclaw/issues)
- Demandez sur le serveur [Discord OpenClaw](https://discord.gg/openclaw)

---

<Tip>
Ce FAQ est maintenu activement. Si vous trouvez des erreurs ou avez des suggestions d'amélioration, [ouvrez un issue](https://github.com/openclaw/openclaw/issues/new) ou soumettez un PR.
</Tip>
