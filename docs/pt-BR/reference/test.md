---
summary: "Como executar testes localmente (vitest) e quando usar os modos force/coverage"
read_when:
  - Executando ou corrigindo testes
title: "Testes"
---

# Testes

- Kit completo de testes (suites, live, Docker): [Testing](/help/testing)

- `pnpm test:force`: Encerra qualquer processo de gateway remanescente que esteja segurando a porta de controle padrão e, em seguida, executa a suíte completa do Vitest com uma porta de gateway isolada para que os testes de servidor não colidam com uma instância em execução. Use isto quando uma execução anterior do gateway deixou a porta 18789 ocupada.

- `pnpm test:coverage`: Executa o Vitest com cobertura V8. Os limites globais são 70% para linhas/branches/funções/statements. A cobertura exclui entrypoints com muita integração (wiring da CLI, bridges gateway/telegram, servidor estático do webchat) para manter o alvo focado em lógica testável por testes unitários.

- `pnpm test:e2e`: Executa testes de smoke end-to-end do gateway (pareamento multi-instância WS/HTTP/node).

- `pnpm test:live`: Executa testes live de provedores (minimax/zai). Requer chaves de API e `LIVE=1` (ou `*_LIVE_TEST=1` específico do provedor) para desativar o skip.

## Bench de latência do modelo (chaves locais)

Script: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Uso:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- Env opcional: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Prompt padrão: “Responda com uma única palavra: ok. Sem pontuação ou texto extra.”

Última execução (2025-12-31, 20 execuções):

- minimax mediana 1279ms (mín 1114, máx 2431)
- opus mediana 2454ms (mín 1224, máx 3170)

## Onboarding E2E (Docker)

Docker é opcional; isto é necessário apenas para testes de smoke de onboarding em contêiner.

Fluxo completo de cold-start em um contêiner Linux limpo:

```bash
scripts/e2e/onboard-docker.sh
```

Este script conduz o assistente interativo via pseudo-tty, verifica arquivos de configuração/workspace/sessão e, em seguida, inicia o gateway e executa `openclaw health`.

## Smoke de importação por QR (Docker)

Garante que `qrcode-terminal` carregue no Node 22+ em Docker:

```bash
pnpm test:docker:qr
```
