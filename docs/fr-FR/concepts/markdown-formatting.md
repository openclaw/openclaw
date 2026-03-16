---
summary: "Pipeline de formatage Markdown pour les canaux sortants"
read_when:
  - Vous modifiez le formatage Markdown ou le découpage pour les canaux sortants
  - Vous ajoutez un nouveau formateur de canal ou mappage de style
  - Vous déboguez des régressions de formatage sur les canaux
title: "Formatage Markdown"
---

# Formatage Markdown

OpenClaw formate le Markdown sortant en le convertissant en une représentation intermédiaire (RI) partagée
avant de rendre la sortie spécifique au canal. La RI garde le
texte source intact tout en portant des plages de style/lien pour que le découpage et le rendu puissent
rester cohérents sur tous les canaux.

## Objectifs

- **Cohérence :** une étape d'analyse, plusieurs rendus.
- **Découpage sûr :** diviser le texte avant le rendu pour que le formatage en ligne ne se
  casse jamais entre les morceaux.
- **Adaptation au canal :** mapper la même RI vers Slack mrkdwn, Telegram HTML et Signal
  plages de style sans réanalyser le Markdown.

## Pipeline

1. **Analyser Markdown → RI**
   - La RI est du texte brut plus des plages de style (gras/italique/barré/code/spoiler) et des plages de lien.
   - Les décalages sont en unités de code UTF-16 donc les plages de style Signal s'alignent avec son API.
   - Les tableaux ne sont analysés que quand un canal opte pour la conversion de tableau.
2. **Découper la RI (format en premier)**
   - Le découpage se produit sur le texte RI avant le rendu.
   - Le formatage en ligne ne se divise pas entre les morceaux ; les plages sont tranchées par morceau.
3. **Rendu par canal**
   - **Slack :** jetons mrkdwn (gras/italique/barré/code), liens comme `<url|label>`.
   - **Telegram :** balises HTML (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`).
   - **Signal :** texte brut + plages `text-style` ; les liens deviennent `label (url)` quand le label diffère.

## Exemple de RI

Markdown d'entrée :

```markdown
Hello **world** — see [docs](https://docs.openclaw.ai).
```

RI (schématique) :

```json
{
  "text": "Hello world — see docs.",
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
}
```

## Où c'est utilisé

- Les adaptateurs sortants Slack, Telegram et Signal rendent depuis la RI.
- Les autres canaux (WhatsApp, iMessage, MS Teams, Discord) utilisent toujours du texte brut ou
  leurs propres règles de formatage, avec la conversion de tableau Markdown appliquée avant
  le découpage quand activée.

## Gestion des tableaux

Les tableaux Markdown ne sont pas supportés de manière cohérente sur tous les clients de chat. Utilisez
`markdown.tables` pour contrôler la conversion par canal (et par compte).

- `code` : rendre les tableaux comme blocs de code (par défaut pour la plupart des canaux).
- `bullets` : convertir chaque ligne en puces (par défaut pour Signal + WhatsApp).
- `off` : désactiver l'analyse et la conversion de tableau ; le texte brut de tableau passe.

Clés de config :

```yaml
channels:
  discord:
    markdown:
      tables: code
    accounts:
      work:
        markdown:
          tables: off
```

## Règles de découpage

- Les limites de morceau viennent des adaptateurs/config de canal et sont appliquées au texte RI.
- Les clôtures de code sont préservées comme un seul bloc avec un saut de ligne final donc les canaux
  les rendent correctement.
- Les préfixes de liste et préfixes de citation de bloc font partie du texte RI, donc le découpage
  ne divise pas en milieu de préfixe.
- Les styles en ligne (gras/italique/barré/code-en-ligne/spoiler) ne sont jamais divisés entre
  les morceaux ; le rendu rouvre les styles à l'intérieur de chaque morceau.

Si vous avez besoin de plus sur le comportement de découpage sur les canaux, voir
[Streaming + découpage](/fr-FR/concepts/streaming).

## Politique de liens

- **Slack :** `[label](url)` -> `<url|label>` ; les URLs nues restent nues. L'autolien
  est désactivé pendant l'analyse pour éviter le double-lien.
- **Telegram :** `[label](url)` -> `<a href="url">label</a>` (mode d'analyse HTML).
- **Signal :** `[label](url)` -> `label (url)` sauf si le label correspond à l'URL.

## Spoilers

Les marqueurs de spoiler (`||spoiler||`) ne sont analysés que pour Signal, où ils mappent vers
les plages de style SPOILER. Les autres canaux les traitent comme du texte brut.

## Comment ajouter ou mettre à jour un formateur de canal

1. **Analyser une fois :** utilisez l'aide `markdownToIR(...)` partagée avec les options
   appropriées au canal (autolien, style d'en-tête, préfixe de citation de bloc).
2. **Rendre :** implémentez un rendu avec `renderMarkdownWithMarkers(...)` et une
   carte de marqueur de style (ou plages de style Signal).
3. **Découper :** appelez `chunkMarkdownIR(...)` avant le rendu ; rendez chaque morceau.
4. **Câbler l'adaptateur :** mettez à jour l'adaptateur sortant de canal pour utiliser le nouveau découpeur
   et rendu.
5. **Tester :** ajoutez ou mettez à jour les tests de format et un test de livraison sortant si le
   canal utilise le découpage.

## Pièges courants

- Les jetons de crochet angulaire Slack (`<@U123>`, `<#C123>`, `<https://...>`) doivent être
  préservés ; échappez HTML brut en toute sécurité.
- Le HTML Telegram nécessite d'échapper le texte en dehors des balises pour éviter le balisage cassé.
- Les plages de style Signal dépendent des décalages UTF-16 ; n'utilisez pas les décalages de point de code.
- Préservez les sauts de ligne finaux pour les blocs de code clôturés pour que les marqueurs de fermeture atterrissent sur
  leur propre ligne.
