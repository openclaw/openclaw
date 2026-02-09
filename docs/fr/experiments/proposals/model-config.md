---
summary: "Exploration : configuration des modeles, profils d'authentification et comportement de bascule"
read_when:
  - Exploration de futures idees de selection de modele + profils d'authentification
title: "Exploration de la configuration des modeles"
---

# Configuration des modeles (Exploration)

Ce document rassemble des **idees** pour une future configuration des modeles. Il ne s'agit pas d'une specification livree. Pour le comportement actuel, voir :

- [Models](/concepts/models)
- [Model failover](/concepts/model-failover)
- [OAuth + profiles](/concepts/oauth)

## Motivation

Les operateurs souhaitent :

- Plusieurs profils d'authentification par fournisseur (personnel vs professionnel).
- Une selection simple `/model` avec des bascules predecibles.
- Une separation claire entre les modeles de texte et les modeles capables de traiter des images.

## Orientation possible (vue d'ensemble)

- Garder la selection des modeles simple : `provider/model` avec des alias optionnels.
- Permettre aux fournisseurs d'avoir plusieurs profils d'authentification, avec un ordre explicite.
- Utiliser une liste globale de bascule afin que toutes les sessions basculent de maniere coherente.
- Ne surcharger le routage des images que lorsqu'il est explicitement configure.

## Questions ouvertes

- La rotation des profils doit-elle etre par fournisseur ou par modele ?
- Comment l'interface utilisateur doit-elle exposer la selection de profil pour une session ?
- Quel est le chemin de migration le plus sûr à partir des clés de configuration héritées?
