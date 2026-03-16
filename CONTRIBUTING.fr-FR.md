# Contribuer à OpenClaw

Bienvenue dans le bassin des homards(Lobster) ! 🦞

## Liens rapides

- **GitHub :** <https://github.com/openclaw/openclaw>
- **Discord :** <https://discord.gg/qkhbAGHRBT>
- **X/Twitter :** [@steipete](https://x.com/steipete) / [@openclaw](https://x.com/openclaw)

## Mainteneurs

- **Peter Steinberger** - Dictateur bienveillant
  - GitHub : [@steipete](https://github.com/steipete) · X : [@steipete](https://x.com/steipete)

- **Shadow** - Sous-système Discord + Slack
  - GitHub : [@thewilloftheshadow](https://github.com/thewilloftheshadow) · X : [@4shad0wed](https://x.com/4shad0wed)

- **Vignesh** - Mémoire (QMD), modélisation formelle, TUI et Lobster
  - GitHub : [@vignesh07](https://github.com/vignesh07) · X : [@\_vgnsh](https://x.com/_vgnsh)

- **Jos** - Telegram, API, mode Nix
  - GitHub : [@joshp123](https://github.com/joshp123) · X : [@jjpcodes](https://x.com/jjpcodes)

- **Christoph Nakazawa** - Infrastructure JS
  - GitHub : [@cpojer](https://github.com/cpojer) · X : [@cnakazawa](https://x.com/cnakazawa)

- **Gustavo Madeira Santana** - Multi-agents, CLI, interface web
  - GitHub : [@gumadeiras](https://github.com/gumadeiras) · X : [@gumadeiras](https://x.com/gumadeiras)

- **Maximilian Nussbaumer** - DevOps, CI, qualité du code
  - GitHub : [@quotentiroler](https://github.com/quotentiroler) · X : [@quotentiroler](https://x.com/quotentiroler)

## Comment contribuer

1. **Bugs et petites corrections** → Ouvrez une PR !
2. **Nouvelles fonctionnalités / architecture** → Démarrez une [Discussion GitHub](https://github.com/openclaw/openclaw/discussions) ou posez la question sur Discord d'abord
3. **Questions** → Discord #setup-help

## Avant de soumettre une PR

- Testez localement avec votre instance OpenClaw
- Lancez les tests : `pnpm build && pnpm check && pnpm test`
- Assurez-vous que les vérifications CI passent
- Gardez les PR concentrées (une chose par PR)
- Décrivez le quoi et le pourquoi

## Décorateurs de l'interface de contrôle

L'interface de contrôle utilise Lit avec des décorateurs **legacy** (l'analyse Rollup actuelle ne prend pas en charge les champs `accessor` requis pour les décorateurs standard). Lors de l'ajout de champs réactifs, conservez le style legacy :

```ts
@state() foo = "bar";
@property({ type: Number }) count = 0;
```

Le `tsconfig.json` racine est configuré pour les décorateurs legacy (`experimentalDecorators: true`) avec `useDefineForClassFields: false`. Évitez de changer cela sauf si vous mettez également à jour les outils de build de l'interface pour prendre en charge les décorateurs standard.

## PR assistées par IA bienvenues ! 🤖

Développé avec Codex, Claude ou d'autres outils IA ? **Super - signalez-le simplement !**

Veuillez inclure dans votre PR :

- [ ] Marquez comme assistée par IA dans le titre ou la description de la PR
- [ ] Indiquez le degré de test (non testé / légèrement testé / entièrement testé)
- [ ] Incluez les prompts ou les logs de session si possible (très utile !)
- [ ] Confirmez que vous comprenez ce que fait le code

Les PR assistées par IA sont des contributions de première classe ici. Nous voulons simplement de la transparence pour que les reviewers sachent à quoi s'attendre.

## Focus actuel et feuille de route 🗺

Nous priorisons actuellement :

- **Stabilité** : Correction des cas limites dans les connexions de canaux (WhatsApp/Telegram).
- **UX** : Amélioration de l'assistant de configuration initiale et des messages d'erreur.
- **Compétences** : Pour les contributions de compétences, rendez-vous sur [ClawHub](https://clawhub.ai/) — le hub communautaire pour les compétences OpenClaw.
- **Performance** : Optimisation de l'utilisation des tokens et de la logique de compaction.

Consultez les [Issues GitHub](https://github.com/openclaw/openclaw/issues) pour les labels "good first issue" !

## Signaler une vulnérabilité

Nous prenons les rapports de sécurité au sérieux. Signalez les vulnérabilités directement au dépôt où se trouve le problème :

- **CLI principal et passerelle** — [openclaw/openclaw](https://github.com/openclaw/openclaw)
- **Application de bureau macOS** — [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/macos)
- **Application iOS** — [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/ios)
- **Application Android** — [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/android)
- **ClawHub** — [openclaw/clawhub](https://github.com/openclaw/clawhub)
- **Modèle de confiance et de menace** — [openclaw/trust](https://github.com/openclaw/trust)

Pour les problèmes qui ne correspondent à aucun dépôt spécifique, ou si vous n'êtes pas sûr, envoyez un e-mail à **<security@openclaw.ai>** et nous le redirigerons.

### Éléments requis dans les rapports

1. **Titre**
2. **Évaluation de la gravité**
3. **Impact**
4. **Composant affecté**
5. **Reproduction technique**
6. **Impact démontré**
7. **Environnement**
8. **Conseil de remédiation**

Les rapports sans étapes de reproduction, impact démontré et conseil de remédiation seront déprioritisés. Étant donné le volume de résultats de scanners générés par IA, nous devons nous assurer que nous recevons des rapports vérifiés de chercheurs qui comprennent les problèmes.
