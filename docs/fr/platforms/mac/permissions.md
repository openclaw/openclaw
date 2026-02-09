---
summary: "Persistance des autorisations macOS (TCC) et exigences de signature"
read_when:
  - Debogage des invites d'autorisations macOS manquantes ou bloquees
  - Packaging ou signature de l'application macOS
  - Changement des identifiants de bundle ou des chemins d'installation de l'application
title: "Autorisations macOS"
---

# Autorisations macOS (TCC)

Les autorisations macOS sont fragiles. TCC associe l'octroi d'une autorisation a la
signature du code de l'application, a l'identifiant de bundle et au chemin sur le disque. Si l'un de ces elements change,
macOS traite l'application comme nouvelle et peut supprimer ou masquer les invites.

## Exigences pour des autorisations stables

- Meme chemin : executez l'application depuis un emplacement fixe (pour OpenClaw, `dist/OpenClaw.app`).
- Meme identifiant de bundle : changer l'ID de bundle cree une nouvelle identite d'autorisation.
- Application signee : les builds non signes ou signes ad-hoc ne conservent pas les autorisations.
- Signature coherente : utilisez un veritable certificat Apple Development ou Developer ID
  afin que la signature reste stable entre les reconstructions.

Les signatures ad-hoc generent une nouvelle identite a chaque build. macOS oubliera les autorisations precedentes,
et les invites peuvent disparaitre completement jusqu'a ce que les entrees obsoletes soient effacees.

## Liste de verification de recuperation lorsque les invites disparaissent

1. Quittez l'application.
2. Supprimez l'entree de l'application dans Reglages systeme -> Confidentialite et securite.
3. Relancez l'application depuis le meme chemin et accordez a nouveau les autorisations.
4. Si l'invite n'apparait toujours pas, reinitialisez les entrees TCC avec `tccutil` et reessayez.
5. Certaines autorisations ne reapparaissent qu'apres un redemarrage complet de macOS.

Exemples de reinitialisation (remplacez l'ID de bundle si necessaire) :

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

## Permissions de fichiers et de dossiers (Bureau/Documents/Téléchargements)

macOS peut également ouvrir des portes, des documents et des téléchargements pour les processus terminaux/arrière-plan. Si des listes de fichiers ou de répertoires sont suspendues, accordez l'accès au même contexte de processus que celui qui effectue des opérations de fichiers (par exemple Terminal/iTerm, Lancement de l'application LaunchAgent, ou processus SSH).

Solution de contournement : déplacez les fichiers dans l'espace de travail OpenClaw (`~/.openclaw/workspace`) si vous voulez éviter les subventions par dossier.

Si vous testez des autorisations, signez toujours avec un veritable certificat. Les builds ad-hoc
ne sont acceptables que pour des executions locales rapides ou les autorisations n'ont pas d'importance.
