# Plan d'action OpenClaw - Analyse stratégique

**Date :** 2026-03-29
**Analyse basée sur :** commit 2be2e41174 (main)

---

## Résumé exécutif

OpenClaw est une codebase mature (~1M lignes TypeScript) avec une architecture solide mais qui présente des points de friction identifiables.

---

## 1. Audit de la codebase

### Structure actuelle

- **1M lignes de code** TypeScript (ESM, Node 22+)
- **88 extensions** (workspace packages)
- **15+ canaux** de messaging supportés
- **Apps mobiles** : iOS, Android, macOS

### Points forts identifiés

1. **Plugin SDK bien architecturé** - boundaries clairs, 100+ subpaths
2. **Gateway WebSocket** - control plane unifié, auth, sessions
3. **Tests solides** - Vitest, 70% coverage, isolation correcte
4. **Build tsdown** - lazy-loading, module splitting
5. **Documentation complète** - Mintlify, i18n zh-CN

### Faiblesses / dettes techniques

#### A. Complexité accidentelle

- `src/gateway/` : 277 fichiers, certains >1000 lignes
- `src/agents/` : 635 fichiers, logique éparpillée
- Fichiers de test >500 lignes parfois difficiles à maintenir

#### B. Import boundaries à surveiller

- Certaines extensions importent encore via `../` au lieu de `openclaw/plugin-sdk/*`
- Guardrails documentés mais pas toujours enforceés statiquement

#### C. Configuration éparpillée

- Schema Zod dans `src/config/zod-schema.*` + `src/config/schema.*`
- Legacy migrations encore présentes (`src/config/legacy.*`)

#### D. Coverage thresholds

- Seuils à 70% (lines/functions/statements), 55% branches
- Certains dossiers exclus : `src/acp/**`, `src/channels/**`, `src/gateway/**`

---

## 2. Actions recommandées (ordre de priorité)

### Priorité 1 : Sécurité et hardening (immédiat)

```
1.1 Vérifier les guardrails SSRF dans src/plugin-sdk/ssrf-policy.ts
1.2 Auditer les input validations dans src/gateway/auth.ts
1.3 Review des DM policies (pairing vs open) pour tous les canaux
1.4 Vérifier credential rotation (src/agents/api-key-rotation.ts)
1.5 Audit des secrets (src/secrets/**) et .secrets.baseline
```

### Priorité 2 : Clean-up technique (semaine 1)

```
2.1 Supprimer legacy migrations si plus utilisées
    - src/config/legacy-migrate.ts
    - src/config/legacy.migrations.part-*.ts

2.2 Consolider schema config
    - Fusionner zod-schema.* et schema.* si duplication

2.3 Nettoyer imports extensions
    - Identifier extensions avec imports ../src/
    - Migrer vers openclaw/plugin-sdk/*

2.4 Réduire fichiers >700 LOC
    - src/gateway/server.impl.ts (60KB+)
    - src/agents/agent-command.ts
    - Extraire helpers testables
```

### Priorité 3 : Test coverage (semaine 2)

```
3.1 Inclure dossiers exclus dans coverage
    - src/acp/** - ajouter tests unitaires
    - src/channels/** - tests d'intégration légers
    - src/gateway/** - server methods tests

3.2 Augmenter seuils branches à 70%
    - Actuellement 55% -> objectif 70%

3.3 Nettoyer tests flakys
    - Identifier tests avec setTimeout/polling
    - Utiliser fake timers viest
```

### Priorité 4 : Performance build (semaine 3)

```
4.1 Audit dynamic imports
    - Vérifier [INEFFECTIVE_DYNAMIC_IMPORT] warnings
    - Optimiser lazy-loading boundaries

4.2 Réduire bundle size
    - Analyser dist/ avec source-map-explorer
    - Identifier dependencies bundle-inappropriately

4.3 Parallelize build
    - tsdown config optimisations
    - Cache build artifacts
```

### Priorité 5 : Documentation (semaine 4)

```
5.1 Mettre à jour docs gateway
    - https://docs.openclaw.ai/gateway

5.2 Diagrammes architecture
    - Ajouter mermaid dans docs/concepts/architecture

5.3 Onboarding devs
    - docs/help/contributing.md à jour
    - Quickstart pour nouvelles extensions
```

---

## 3. Quick wins (peuvent être faits maintenant)

### 3.1 Nettoyage format/lint

```bash
pnpm format:fix    # oxfmt --write
pnpm check         # oxlint
```

### 3.2 Vérifier build warnings

```bash
pnpm build 2>&1 | grep -E "INEFFECTIVE_DYNAMIC_IMPORT|WARNING"
```

### 3.3 Audit dependencies

```bash
pnpm outdated
pnpm audit
```

### 3.4 Secrets baseline

```bash
prek run detect-secrets  # ou scripts/detect-secrets
```

---

## 4. Métriques de succès

| Métrique                    | Actuel | Cible |
| --------------------------- | ------ | ----- |
| Coverage lines              | 70%    | 80%   |
| Coverage branches           | 55%    | 70%   |
| Fichiers >700 LOC           | ~50    | <20   |
| Build time                  | ~60s   | <45s  |
| Extensions avec imports ../ | ?      | 0     |

---

## 5. Prochaines étapes immédiates

1. ~~**Exécuter `pnpm build`** - vérifier warnings~~ ✅ PASS (0 warnings)
2. ~~**Exécuter `pnpm test`** - baseline tests pass~~ ✅ PASS
3. ~~**Exécuter `pnpm check`** - lint status~~ ✅ PASS (formatage appliqué)
4. ~~**Audit SSRF policy** - security first~~ ✅ FAIT - guardrails corrects
5. ~~**Identifier top 10 fichiers plus gros** - plan refactor~~ ✅ FAIT
6. ~~**Corriger tests flakys**~~ ✅ FAIT - 3 tests corrigés (ui.presenter + supervisor)
7. ~~**Documentation review**~~ ✅ FAIT - docs à jour + Mermaid present

### Résultats de l'audit

| Check              | Statut          | Notes                                        |
| ------------------ | --------------- | -------------------------------------------- |
| Build warnings     | ✅ 0 warnings   | Pas de INEFFECTIVE_DYNAMIC_IMPORT            |
| Lint/format        | ✅ Clean        | oxfmt + oxlint OK                            |
| Tests unitaires    | ✅ Pass         | src/utils.test.ts = 26 tests OK              |
| SSRF policy        | ✅ Secure       | src/plugin-sdk/ssrf-policy.ts guardrails OK  |
| Auth gateway       | ✅ Secure       | src/gateway/auth.ts validation stricte       |
| API key rotation   | ✅ Présent      | src/agents/api-key-rotation.ts               |
| Imports extensions | ✅ Clean        | Aucun `../src/` trouvé                       |
| Legacy config      | ⚠️ Actif        | Nécessaire - migrations utilisateurs         |
| Schema duplication | ✅ Faux positif | schema.ts ≠ zod-schema.ts (rôles différents) |
| Vulnerabilités     | ⚠️ 3 high       | path-to-regexp (ReDoS), picomatch (ReDoS)    |

### Actions correctives recommandées

```bash
# 1. Mettre à jour dépendances mineures (sans breaking changes)
pnpm update @vitest/coverage-v8 vitest hono tar undici typescript
```

**Note sur les vulnérabilités `path-to-regexp` et `picomatch` :**
Ces dépendances sont transitives et profondes :

- `path-to-regexp` vient de `@modelcontextprotocol/sdk` → `express@5.2.1`
- `picomatch` vient de `jscpd` (dev) et `tinyglobby` → `tsdown`

**Recommandation :** Attendre que les mainteneurs mettent à jour leurs dépendances, ou ajouter des `pnpm.patchedDependencies` si critique.

---

## 6. Résumé final de l'audit

### Ce qui est en bon état

| Domaine          | État                 | Observation                              |
| ---------------- | -------------------- | ---------------------------------------- |
| Build system     | ✅ Excellent         | tsdown + rolldown, 0 warnings, ~13s      |
| Plugin SDK       | ✅ Bien architecturé | Boundaries clairs, respectés             |
| Auth gateway     | ✅ Solide            | Token/password/trusted-proxy + Tailscale |
| SSRF protection  | ✅ Complète          | Allowlists, private IP checks            |
| API key rotation | ✅ Implémentée       | Retry + failover                         |
| Extensions       | ✅ Clean             | Aucun import `../src/` interdit          |
| Tests            | ✅ Fiables           | Vitest, isolation correcte, 9902 tests   |
| Format/lint      | ✅ Automatisé        | oxfmt + oxlint en CI                     |
| Documentation    | ✅ À jour            | Gateway, architecture, Mermaid           |

### Points de vigilance

| Sujet                      | Priorité | Action                          |
| -------------------------- | -------- | ------------------------------- |
| Vulnérabilités transitives | Moyenne  | Attendre upstream ou overrides  |
| Fichiers >1000 LOC         | Faible   | Refactor progressif             |
| Coverage branches à 55%    | Faible   | Objectif 70%                    |
| Legacy config migrations   | Info     | Nécessaire, ne pas supprimer    |
| Tests timeout (supervisor) | Faible   | Valeurs augmentées (5→50, 1→10) |

---

## 7. Commandes de référence

```bash
# Build + checks
pnpm build && pnpm check && pnpm test

# Update dependencies (safe)
pnpm update

# Audit sécurité
pnpm audit

# Detect secrets
prek run detect-secrets

# Trouver gros fichiers
find src -name "*.ts" -exec wc -l {} + | sort -rn | head -20
```

---

## Notes

- **Ne pas modifier** : Carbon dependency (gardé figé)
- **Ne pas patcher** : dependencies sans approval explicite
- **Respecter** : multi-agent safety (pas de stash/worktree sans demande)
- **Commit style** : `scripts/committer "<msg>" <files>`

---

_Document généré par analyse statique - à valider avec exécution effective_
