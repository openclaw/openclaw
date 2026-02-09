---
summary: "Mode exec eleve et directives /elevated"
read_when:
  - Ajustement des valeurs par defaut du mode eleve, des listes d’autorisation ou du comportement des commandes slash
title: "Mode eleve"
---

# Mode eleve (/elevated directives)

## Ce que cela fait

- `/elevated on` s’execute sur l’hote de la Gateway (passerelle) et conserve les validations d’exec (identique a `/elevated ask`).
- `/elevated full` s’execute sur l’hote de la Gateway (passerelle) **et** approuve automatiquement exec (ignore les validations d’exec).
- `/elevated ask` s’execute sur l’hote de la Gateway (passerelle) mais conserve les validations d’exec (identique a `/elevated on`).
- `on`/`ask` ne forcent **pas** `exec.security=full` ; la politique de securite/demande configuree continue de s’appliquer.
- Ne change le comportement que lorsque l’agent est **en sandbox** (sinon exec s’execute deja sur l’hote).
- Formes de directives : `/elevated on|off|ask|full`, `/elev on|off|ask|full`.
- Seules les `on|off|ask|full` sont acceptees ; toute autre valeur renvoie un indice et ne modifie pas l’etat.

## Ce que cela controle (et ce que cela ne controle pas)

- **Gates de disponibilite** : `tools.elevated` est la base globale. `agents.list[].tools.elevated` peut restreindre davantage le mode eleve par agent (les deux doivent autoriser).
- **Etat par session** : `/elevated on|off|ask|full` definit le niveau eleve pour la cle de session courante.
- **Directive inline** : `/elevated on|ask|full` a l’interieur d’un message s’applique uniquement a ce message.
- **Groupes** : dans les discussions de groupe, les directives elevees ne sont honorees que lorsque l’agent est mentionne. Les messages contenant uniquement des commandes qui contournent l’exigence de mention sont traites comme mentionnes.
- **Execution sur l’hote** : le mode eleve force `exec` sur l’hote de la Gateway (passerelle) ; `full` definit egalement `security=full`.
- **Validations** : `full` ignore les validations d’exec ; `on`/`ask` les respectent lorsque les regles de liste d’autorisation/demande l’exigent.
- **Agents non en sandbox** : aucun effet sur l’emplacement ; n’affecte que le gating, la journalisation et l’etat.
- **La politique des outils s’applique toujours** : si `exec` est refuse par la politique des outils, le mode eleve ne peut pas etre utilise.
- **Distinct de `/exec`** : `/exec` ajuste les valeurs par defaut par session pour les expéditeurs autorises et ne necessite pas le mode eleve.

## Ordre de resolution

1. Directive inline dans le message (s’applique uniquement a ce message).
2. Surcharge de session (definie en envoyant un message contenant uniquement une directive).
3. Valeur par defaut globale (`agents.defaults.elevatedDefault` dans la configuration).

## Definir une valeur par defaut de session

- Envoyez un message qui est **uniquement** la directive (espaces autorises), par exemple `/elevated full`.
- Une reponse de confirmation est envoyee (`Elevated mode set to full...` / `Elevated mode disabled.`).
- Si l’acces eleve est desactive ou si l’expediteur n’est pas sur la liste d’autorisation approuvee, la directive renvoie une erreur actionnable et ne modifie pas l’etat de la session.
- Envoyez `/elevated` (ou `/elevated:`) sans argument pour voir le niveau eleve actuel.

## Disponibilite + listes d’autorisation

- Gate de fonctionnalite : `tools.elevated.enabled` (la valeur par defaut peut etre desactivee via la configuration meme si le code le prend en charge).
- Liste d’autorisation des expediteurs : `tools.elevated.allowFrom` avec des listes par fournisseur (par ex. `discord`, `whatsapp`).
- Gate par agent : `agents.list[].tools.elevated.enabled` (optionnel ; ne peut que restreindre davantage).
- Liste d’autorisation par agent : `agents.list[].tools.elevated.allowFrom` (optionnel ; lorsqu’elle est definie, l’expediteur doit correspondre **aux deux** listes d’autorisation globale + par agent).
- Repli Discord : si `tools.elevated.allowFrom.discord` est omis, la liste `channels.discord.dm.allowFrom` est utilisee comme repli. Definissez `tools.elevated.allowFrom.discord` (meme `[]`) pour remplacer. Les listes d’autorisation par agent n’utilisent **pas** le repli.
- Tous les gates doivent passer ; sinon le mode eleve est traite comme indisponible.

## Journalisation + statut

- Les appels exec en mode eleve sont journalises au niveau info.
- L’etat de la session inclut le mode eleve (par ex. `elevated=ask`, `elevated=full`).
