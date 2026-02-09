---
summary: "Pipeline de mise en forme Markdown pour les canaux sortants"
read_when:
  - Vous modifiez la mise en forme Markdown ou le découpage en segments pour les canaux sortants
  - Vous ajoutez un nouveau formateur de canal ou un mappage de styles
  - Vous corrigez des régressions de mise en forme entre les canaux
title: "Mise en forme Markdown"
---

# Mise en forme Markdown

OpenClaw met en forme le Markdown sortant en le convertissant en une
représentation intermédiaire partagée (IR) avant de produire un rendu spécifique
à chaque canal. L’IR conserve le texte source intact tout en transportant des
plages de styles/liens afin que le découpage en segments et le rendu restent
cohérents entre les canaux.

## Objectifs

- **Cohérence :** une seule étape de parsing, plusieurs moteurs de rendu.
- **Découpage sûr :** diviser le texte avant le rendu afin que la mise en forme en
  ligne ne se casse jamais entre les segments.
- **Adaptation au canal :** mapper la même IR vers le mrkdwn Slack, le HTML
  Telegram et les plages de styles Signal sans reparser le Markdown.

## Pipeline

1. **Parser le Markdown -> IR**
   - L’IR est du texte brut plus des plages de styles (gras/italique/barré/code/spoiler) et des plages de liens.
   - Les décalages utilisent des unités de code UTF-16 afin que les plages de styles Signal s’alignent avec son API.
   - Les tableaux ne sont parsés que lorsqu’un canal choisit explicitement la conversion des tableaux.
2. **Découper l’IR (format d’abord)**
   - Le découpage a lieu sur le texte de l’IR avant le rendu.
   - La mise en forme en ligne ne se coupe pas entre les segments ; les plages sont découpées par segment.
3. **Rendre par canal**
   - **Slack :** jetons mrkdwn (gras/italique/barré/code), liens sous forme `<url|label>`.
   - **Telegram :** balises HTML (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`).
   - **Signal :** texte brut + plages `text-style` ; les liens deviennent `label (url)` lorsque le libellé diffère.

## Exemple d’IR

Markdown en entrée :

```markdown
Hello **world** — see [docs](https://docs.openclaw.ai).
```

IR (schématique) :

```json
{
  "text": "Hello world — see docs.",
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
}
```

## Où c’est utilisé

- Les adaptateurs sortants Slack, Telegram et Signal produisent leur rendu à partir de l’IR.
- Les autres canaux (WhatsApp, iMessage, MS Teams, Discord) utilisent encore du texte brut ou
  leurs propres règles de mise en forme, avec la conversion des tableaux Markdown appliquée avant
  le découpage lorsqu’elle est activée.

## Gestion des tableaux

Les tableaux Markdown ne sont pas pris en charge de manière cohérente entre les clients de chat. Utilisez
`markdown.tables` pour contrôler la conversion par canal (et par compte).

- `code` : rendre les tableaux sous forme de blocs de code (valeur par défaut pour la plupart des canaux).
- `bullets` : convertir chaque ligne en puces (valeur par défaut pour Signal + WhatsApp).
- `off` : désactiver le parsing et la conversion des tableaux ; le texte brut du tableau est transmis tel quel.

Clés de configuration :

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

- Les limites de découpage proviennent des adaptateurs/configurations de canal et s’appliquent au texte de l’IR.
- Les blocs de code sont conservés comme un seul bloc avec un retour à la ligne final afin que les canaux
  les rendent correctement.
- Les préfixes de listes et de citations font partie du texte de l’IR ; le découpage ne coupe donc pas au milieu d’un préfixe.
- Les styles en ligne (gras/italique/barré/code en ligne/spoiler) ne sont jamais coupés entre les segments ; le moteur de rendu rouvre les styles dans chaque segment.

Si vous avez besoin de plus de détails sur le comportement du découpage entre les canaux, voir
[Streaming + chunking](/concepts/streaming).

## Politique des liens

- **Slack :** `[label](url)` -> `<url|label>` ; les URL nues restent nues. L’autolink
  est désactivé lors du parsing pour éviter le double lien.
- **Telegram :** `[label](url)` -> `<a href="url">label</a>` (mode de parsing HTML).
- **Signal :** `[label](url)` -> `label (url)` sauf si le libellé correspond à l’URL.

## Spoilers

Les marqueurs de spoiler (`||spoiler||`) ne sont parsés que pour Signal, où ils se mappent à
des plages de style SPOILER. Les autres canaux les traitent comme du texte brut.

## Comment ajouter ou mettre à jour un formateur de canal

1. **Parser une seule fois :** utiliser l’assistant partagé `markdownToIR(...)` avec des options
   adaptées au canal (autolink, style de titre, préfixe de citation).
2. **Rendre :** implémenter un moteur de rendu avec `renderMarkdownWithMarkers(...)` et une
   table de mappage des marqueurs de style (ou des plages de styles Signal).
3. **Découper :** appeler `chunkMarkdownIR(...)` avant le rendu ; rendre chaque segment.
4. **Raccorder l’adaptateur :** mettre à jour l’adaptateur sortant du canal pour utiliser le nouveau découpeur
   et le moteur de rendu.
5. **Tester :** ajouter ou mettre à jour les tests de mise en forme et un test de livraison sortante si le
   canal utilise le découpage.

## Gouchettes communes

- Les jetons à chevrons Slack (`<@U123>`, `<#C123>`, `<https://...>`) doivent être
  préservés ; échapper le HTML brut en toute sécurité.
- Le HTML Telegram nécessite d’échapper le texte en dehors des balises pour éviter un balisage cassé.
- Les plages de styles Signal dépendent des décalages UTF-16 ; n’utilisez pas des décalages en points de code.
- Préserver les retours à la ligne finaux pour les blocs de code délimités afin que les marqueurs de fermeture
  se retrouvent sur leur propre ligne.
