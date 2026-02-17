---
summary: "Comment run tests localement (vitest) et quand utiliser modes force/coverage"
read_when:
  - Run ou fix tests
title: "Tests"
---

# Tests

- Kit testing complet (suites, live, Docker) : [Testing](/fr-FR/help/testing)

- `pnpm test:force` : Kill processus passerelle lingering tenant port contrôle défaut, puis run suite Vitest complète avec port passerelle isolé pour tests serveur ne collisionnent pas avec instance running. Utilisez quand run passerelle prior laissé port 18789 occupé.
- `pnpm test:coverage` : Run suite unit avec couverture V8 (via `vitest.unit.config.ts`). Seuils globaux 70% lines/branches/functions/statements. Couverture exclut entrypoints integration-heavy (wiring CLI, bridges passerelle/telegram, serveur statique webchat) pour garder cible focalisée sur logique unit-testable.
- `pnpm test` sur Node 24+ : OpenClaw auto-désactive Vitest `vmForks` et utilise `forks` pour éviter `ERR_VM_MODULE_LINK_FAILURE` / `module is already linked`. Vous pouvez forcer comportement avec `OPENCLAW_TEST_VM_FORKS=0|1`.
- `pnpm test:e2e` : Run tests smoke e2e passerelle (pairing multi-instance WS/HTTP/node). Défaut `vmForks` + workers adaptatifs dans `vitest.e2e.config.ts` ; tune avec `OPENCLAW_E2E_WORKERS=<n>` et définir `OPENCLAW_E2E_VERBOSE=1` pour logs verbose.
- `pnpm test:live` : Run tests live provider (minimax/zai). Nécessite clés API et `LIVE=1` (ou spécifique provider `*_LIVE_TEST=1`) pour unskip.

## Bench latence model (clés locales)

Script : [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Usage :

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- Env optionnel : `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Prompt défaut : "Reply with a single word: ok. No punctuation or extra text."

Dernier run (2025-12-31, 20 runs) :

- minimax median 1279ms (min 1114, max 2431)
- opus median 2454ms (min 1224, max 3170)

## E2E Onboarding (Docker)

Docker optionnel ; seulement nécessaire pour tests smoke onboarding containerisés.

Flux cold-start complet dans conteneur Linux clean :

```bash
scripts/e2e/onboard-docker.sh
```

Ce script drive wizard interactif via pseudo-tty, vérifie fichiers config/workspace/session, puis démarre passerelle et run `openclaw health`.

## Smoke import QR (Docker)

Assure `qrcode-terminal` charge sous Node 22+ dans Docker :

```bash
pnpm test:docker:qr
```

## Commandes Tests

```bash
# Run tous tests unit
pnpm test

# Run avec coverage
pnpm test:coverage

# Force kill passerelle + run tests
pnpm test:force

# Tests E2E
pnpm test:e2e

# Tests provider live
LIVE=1 pnpm test:live

# Tests smoke install
pnpm test:install:smoke

# Tests E2E install OpenAI
pnpm test:install:e2e:openai

# Tests E2E install Anthropic
pnpm test:install:e2e:anthropic
```

## Structure Tests

```
test/
├── unit/           # Tests unit
├── e2e/            # Tests end-to-end
├── live/           # Tests provider live
└── fixtures/       # Data test
```

## Writing Tests

### Test Unit Basique

```typescript
import { describe, it, expect } from "vitest";
import { myFunction } from "../src/my-module";

describe("myFunction", () => {
  it("devrait retourner résultat attendu", () => {
    const result = myFunction("input");
    expect(result).toBe("expected");
  });
});
```

### Test Async

```typescript
it("devrait gérer opérations async", async () => {
  const result = await asyncFunction();
  expect(result).toBeDefined();
});
```

### Test Mocks

```typescript
import { vi } from "vitest";

it("devrait mocker dependencies", () => {
  const mockFn = vi.fn().mockReturnValue("mocked");
  const result = functionUsingDep(mockFn);
  expect(mockFn).toHaveBeenCalled();
});
```

## Configuration Coverage

Seuils dans `vitest.unit.config.ts` :

```typescript
coverage: {
  provider: 'v8',
  thresholds: {
    lines: 70,
    branches: 70,
    functions: 70,
    statements: 70
  }
}
```

## CI/CD

Tests run automatiquement dans CI :

```yaml
# .github/workflows/test.yml
- name: Run tests
  run: pnpm test
- name: Coverage
  run: pnpm test:coverage
```

## Troubleshooting

**Tests timeout :**

```bash
# Augmenter timeout
pnpm test --test-timeout=60000
```

**Port occupé :**

```bash
# Utiliser test:force
pnpm test:force
```

**Flaky tests :**

```bash
# Run test spécifique plusieurs fois
pnpm test --run --reporter=verbose <test-file>
```

Voir aussi :

- [Testing](/fr-FR/help/testing)
- [Debugging](/fr-FR/help/debugging)
