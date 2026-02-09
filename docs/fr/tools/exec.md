---
summary: "Utilisation de l’outil Exec, modes stdin et prise en charge du TTY"
read_when:
  - Utilisation ou modification de l’outil exec
  - Debogage du comportement stdin ou TTY
title: "Outil Exec"
---

# Outil Exec

Execute des commandes shell dans l’espace de travail. Prend en charge l’execution au premier plan et en arriere-plan via `process`.
Si `process` est interdit, `exec` s’execute de maniere synchrone et ignore `yieldMs`/`background`.
Les sessions en arriere-plan sont limitees par agent ; `process` ne voit que les sessions du meme agent.

## Parametres

- `command` (requis)
- `workdir` (par defaut : cwd)
- `env` (surcharges cle/valeur)
- `yieldMs` (par defaut 10000) : passage automatique en arriere-plan apres delai
- `background` (bool) : passer immediatement en arriere-plan
- `timeout` (secondes, par defaut 1800) : arret a l’expiration
- `pty` (bool) : executer dans un pseudo-terminal quand disponible (CLI uniquement TTY, agents de code, interfaces terminal)
- `host` (`sandbox | gateway | node`) : ou executer
- `security` (`deny | allowlist | full`) : mode d’application pour `gateway`/`node`
- `ask` (`off | on-miss | always`) : invites d’approbation pour `gateway`/`node`
- `node` (string) : id/nom du nœud pour `host=node`
- `elevated` (bool) : demander le mode eleve (hote de la Gateway (passerelle)) ; `security=full` n’est force que lorsque l’elevation aboutit a `full`

Notes :

- `host` a pour valeur par defaut `sandbox`.
- `elevated` est ignore lorsque le sandboxing est desactive (exec s’execute deja sur l’hote).
- Les approbations `gateway`/`node` sont controlees par `~/.openclaw/exec-approvals.json`.
- `node` necessite un nœud associe (application compagnon ou hote de nœud headless).
- Si plusieurs nœuds sont disponibles, definissez `exec.node` ou `tools.exec.node` pour en selectionner un.
- Sur les hôtes non Windows, exec utilise `SHELL` lorsqu’il est defini ; si `SHELL` vaut `fish`, il prefere `bash` (ou `sh`)
  depuis `PATH` afin d’eviter les scripts incompatibles avec fish, puis se rabat sur `SHELL` si aucun n’existe.
- L’execution sur l’hote (`gateway`/`node`) rejette `env.PATH` et les surcharges du chargeur (`LD_*`/`DYLD_*`) afin de
  prevenir le detournement de binaires ou l’injection de code.
- Important : le sandboxing est **desactive par defaut**. Si le sandboxing est desactive, `host=sandbox` s’execute directement sur
  l’hote de la Gateway (passerelle) (sans conteneur) et **ne requiert pas d’approbations**. Pour exiger des approbations, lancez avec
  `host=gateway` et configurez les approbations exec (ou activez le sandboxing).

## Configuration

- `tools.exec.notifyOnExit` (par defaut : true) : lorsque true, les sessions exec mises en arriere-plan mettent en file un evenement systeme et demandent un heartbeat a la sortie.
- `tools.exec.approvalRunningNoticeMs` (par defaut : 10000) : emet un unique avis « running » lorsqu’un exec soumis a approbation dure plus longtemps que ce delai (0 desactive).
- `tools.exec.host` (par defaut : `sandbox`)
- `tools.exec.security` (par defaut : `deny` pour le sandbox, `allowlist` pour Gateway (passerelle) + nœud lorsque non defini)
- `tools.exec.ask` (par defaut : `on-miss`)
- `tools.exec.node` (par defaut : non defini)
- `tools.exec.pathPrepend` : liste de repertoires a prefixer a `PATH` pour les executions exec.
- `tools.exec.safeBins` : binaires surs en stdin uniquement pouvant s’executer sans entrees explicites dans la liste d’autorisation.

Exemple :

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### Gestion de PATH

- `host=gateway` : fusionne votre `PATH` de shell de connexion dans l’environnement exec. Les surcharges `env.PATH` sont
  rejetees pour l’execution sur l’hote. Le demon lui-meme s’execute toujours avec un `PATH` minimal :
  - macOS : `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux : `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox` : execute `sh -lc` (shell de connexion) a l’interieur du conteneur, de sorte que `/etc/profile` peut reinitialiser `PATH`.
  OpenClaw prefixe `env.PATH` apres le sourcage des profils via une variable d’environnement interne (sans interpolation du shell) ;
  `tools.exec.pathPrepend` s’applique ici aussi.
- `host=node` : seules les surcharges d’environnement non bloquees que vous passez sont envoyees au nœud. Les surcharges `env.PATH` sont
  rejetees pour l’execution sur l’hote. Les hôtes de nœud headless acceptent `PATH` uniquement lorsqu’il prefixe le PATH de l’hote
  du nœud (pas de remplacement). Les nœuds macOS abandonnent entierement les surcharges `PATH`.

Liaison de nœud par agent (utilisez l’index de la liste d’agents dans la configuration) :

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Interface de controle : l’onglet Nœuds inclut un petit panneau « Exec node binding » pour les memes parametres.

## Surcharges de session (`/exec`)

Utilisez `/exec` pour definir des valeurs par defaut **par session** pour `host`, `security`, `ask` et `node`.
Envoyez `/exec` sans arguments pour afficher les valeurs actuelles.

Exemple :

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Modele d’autorisation

`/exec` n’est honore que pour les **expediteurs autorises** (listes d’autorisation de canaux/appairage plus `commands.useAccessGroups`).
Il met a jour **uniquement l’etat de la session** et n’ecrit pas la configuration. Pour desactiver exec de maniere definitive, refusez-le via la politique
d’outil (`tools.deny: ["exec"]` ou par agent). Les approbations sur l’hote s’appliquent toujours, sauf si vous definissez explicitement
`security=full` et `ask=off`.

## Approbations exec (application compagnon / hote de nœud)

Les agents en sandbox peuvent exiger une approbation par requete avant que `exec` ne s’execute sur l’hote de la Gateway (passerelle) ou du nœud.
Voir [Exec approvals](/tools/exec-approvals) pour la politique, la liste d’autorisation et le flux UI.

Lorsque des approbations sont requises, l’outil exec retourne immediatement avec
`status: "approval-pending"` et un identifiant d’approbation. Une fois approuve (ou refuse / expire),
la Gateway (passerelle) emet des evenements systeme (`Exec finished` / `Exec denied`). Si la commande est toujours
en cours d’execution apres `tools.exec.approvalRunningNoticeMs`, un unique avis `Exec running` est emis.

## Liste d’autorisation + binaires surs

L’application de la liste d’autorisation correspond **uniquement aux chemins de binaires resolus** (pas de correspondance par nom de base). Lorsque
`security=allowlist`, les commandes shell sont auto-autorisees uniquement si chaque segment du pipeline est
autorise par la liste ou est un binaire sur. Le chainage (`;`, `&&`, `||`) et les redirections sont rejetes en
mode liste d’autorisation.

## Exemples

Premier plan :

```json
{ "tool": "exec", "command": "ls -la" }
```

Arrière-plan + sondage :

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

Envoyer des touches (style tmux) :

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

Soumettre (envoyer CR uniquement) :

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

Coller (encadre par defaut) :

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (experimental)

`apply_patch` est un sous-outil de `exec` pour des modifications structurees multi-fichiers.
Activez-le explicitement :

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

Notes :

- Disponible uniquement pour les modeles OpenAI/OpenAI Codex.
- La politique d’outil s’applique toujours ; `allow: ["exec"]` autorise implicitement `apply_patch`.
- La configuration se trouve sous `tools.exec.applyPatch`.
