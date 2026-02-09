---
summary: "Renforcement de la liste d’autorisation Telegram : normalisation des prefixes et des espaces"
read_when:
  - Lors de la revue des changements historiques de la liste d’autorisation Telegram
title: "Renforcement de la liste d’autorisation Telegram"
---

# Renforcement de la liste d’autorisation Telegram

**Date** : 2026-01-05  
**Statut** : Complet  
**PR** : #216

## Summary

Les listes d’autorisation Telegram acceptent désormais les prefixes `telegram:` et `tg:` sans distinction de casse, et tolerent
les espaces accidentels. Cela aligne les verifications entrantes de la liste d’autorisation avec la normalisation des envois sortants.

## Ce qui a change

- Les prefixes `telegram:` et `tg:` sont traites de la meme maniere (sans distinction de casse).
- Les entrees de la liste d’autorisation sont tronquees ; les entrees vides sont ignorees.

## Exemples

Tous les elements suivants sont acceptes pour le meme identifiant :

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## Pourquoi c’est important

Le copier/coller depuis les journaux ou les identifiants de discussion inclut souvent des prefixes et des espaces. La normalisation evite des faux negatifs lors de la decision de repondre dans les Messages prives ou les groupes.

## Documents associes

- [Group Chats](/concepts/groups)
- [Telegram Provider](/channels/telegram)
