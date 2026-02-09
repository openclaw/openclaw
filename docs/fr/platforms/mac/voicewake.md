---
summary: "Modes de reveil vocal et push-to-talk, ainsi que les details de routage dans l’application mac"
read_when:
  - Travail sur les parcours de reveil vocal ou de PTT
title: "Reveil vocal"
---

# Reveil vocal & Push-to-Talk

## Modes

- **Mode mot declencheur** (par defaut) : le reconnaisseur vocal toujours actif attend des jetons declencheurs (`swabbleTriggerWords`). A la detection, il demarre la capture, affiche la superposition avec le texte partiel et envoie automatiquement apres un silence.
- **Push-to-talk (maintien Option droite)** : maintenez la touche Option droite pour capturer immediatement — aucun declencheur requis. La superposition apparait tant que la touche est maintenue ; le relachement finalise et transmet apres un court delai afin que vous puissiez ajuster le texte.

## Comportement a l’execution (mot declencheur)

- Le reconnaisseur vocal s’execute dans `VoiceWakeRuntime`.
- Le declencheur ne s’active que s’il y a une **pause significative** entre le mot declencheur et le mot suivant (~0,55 s d’intervalle). La superposition/le carillon peut demarrer pendant la pause, avant meme que la commande ne commence.
- Fenetres de silence : 2,0 s lorsque la parole est continue, 5,0 s si seul le declencheur a ete entendu.
- Arret force : 120 s pour eviter les sessions incontrôlées.
- Anti-rebond entre sessions : 350 ms.
- La superposition est pilotee via `VoiceWakeOverlayController` avec une coloration engagee/volatile.
- Apres l’envoi, le reconnaisseur redemarre proprement pour ecouter le prochain declencheur.

## Invariants du cycle de vie

- Si le reveil vocal est active et que les autorisations sont accordees, le reconnaisseur de mot declencheur doit etre a l’ecoute (sauf pendant une capture push-to-talk explicite).
- La visibilite de la superposition (y compris la fermeture manuelle via le bouton X) ne doit jamais empecher la reprise de l’ecoute par le reconnaisseur.

## Mode de defaillance de superposition « collante » (precedent)

Auparavant, si la superposition restait visible et que vous la fermiez manuellement, le reveil vocal pouvait sembler « mort » car la tentative de redemarrage du runtime pouvait etre bloquee par la visibilite de la superposition et aucun redemarrage ulterieur n’etait planifie.

Renforcement :

- Le redemarrage du runtime de reveil n’est plus bloque par la visibilite de la superposition.
- La fin de la fermeture de la superposition declenche un `VoiceWakeRuntime.refresh(...)` via `VoiceSessionCoordinator`, de sorte qu’une fermeture manuelle par X reprend toujours l’ecoute.

## Specificites du push-to-talk

- La detection du raccourci utilise un moniteur global `.flagsChanged` pour **Option droite** (`keyCode 61` + `.option`). Nous observons uniquement les evenements (aucune interception).
- La pipeline de capture reside dans `VoicePushToTalk` : demarre immediatement la reconnaissance vocale, diffuse les partiels vers la superposition et appelle `VoiceWakeForwarder` au relachement.
- Lorsque le push-to-talk demarre, nous mettons en pause le runtime de mot declencheur pour eviter des prises audio concurrentes ; il redemarre automatiquement apres le relachement.
- Autorisations : Microphone + Reconnaissance vocale requis ; la visualisation des evenements necessite l’autorisation Accessibilite/Surveillance des entrees.
- Claviers externes : certains peuvent ne pas exposer Option droite comme prevu — proposer un raccourci de secours si les utilisateurs signalent des ratés.

## Parametres visibles par l’utilisateur

- **Reveil vocal** : active le runtime de mot declencheur.
- **Maintenir Cmd+Fn pour parler** : active le moniteur push-to-talk. Desactive sur macOS < 26.
- Selecteurs de langue et de micro, vu-metre en direct, table des mots declencheurs, testeur (local uniquement ; ne transmet pas).
- Le selecteur de micro conserve la derniere selection si un appareil se deconnecte, affiche un indice de deconnexion et bascule temporairement sur le micro systeme par defaut jusqu’a son retour.
- **Sons** : carillons a la detection du declencheur et a l’envoi ; par defaut, le son systeme macOS « Glass ». Vous pouvez choisir n’importe quel fichier chargeable par `NSSound` (p. ex. MP3/WAV/AIFF) pour chaque evenement ou choisir **Aucun son**.

## Comportement de transfert

- Lorsque le reveil vocal est active, les transcriptions sont transmises au gateway/agent actif (le meme mode local vs distant que le reste de l’application mac).
- Les reponses sont delivrees au **dernier fournisseur principal utilise** (WhatsApp/Telegram/Discord/WebChat). En cas d’echec de livraison, l’erreur est consignée et l’execution reste visible via WebChat/journaux de session.

## Charge utile de transfert

- `VoiceWakeForwarder.prefixedTranscript(_:)` prepend l’indication de machine avant l’envoi. Partage entre les parcours mot declencheur et push-to-talk.

## Verification rapide

- Activez le push-to-talk, maintenez Cmd+Fn, parlez, relachez : la superposition doit afficher des partiels puis envoyer.
- Pendant le maintien, les oreilles de la barre de menus doivent rester agrandies (utilise `triggerVoiceEars(ttl:nil)`) ; elles se reduisent apres le relachement.
