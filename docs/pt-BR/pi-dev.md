---
title: "Fluxo de desenvolvimento do Pi"
---

# Fluxo de desenvolvimento do Pi

Este guia resume um fluxo de trabalho sensato para trabalhar na integração do Pi no OpenClaw.

## Verificação de tipos e linting

- Verificar tipos e build: `pnpm build`
- Lint: `pnpm lint`
- Verificação de formatação: `pnpm format`
- Gate completo antes de enviar: `pnpm lint && pnpm build && pnpm test`

## Executando testes do Pi

Use o script dedicado para o conjunto de testes de integração do Pi:

```bash
scripts/pi/run-tests.sh
```

Para incluir o teste ao vivo que exercita o comportamento real do provedor:

```bash
scripts/pi/run-tests.sh --live
```

O script executa todos os testes unitários relacionados ao Pi por meio destes globs:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## Testes manuais

Fluxo recomendado:

- Execute o gateway em modo de desenvolvimento:
  - `pnpm gateway:dev`
- Dispare o agente diretamente:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- Use o TUI para depuração interativa:
  - `pnpm tui`

Para o comportamento de chamadas de ferramentas, faça um prompt para uma ação de `read` ou `exec` para que você possa ver o streaming de ferramentas e o tratamento de payload.

## Reset para estado limpo

O estado fica sob o diretório de estado do OpenClaw. O padrão é `~/.openclaw`. Se `OPENCLAW_STATE_DIR` estiver definido, use esse diretório em vez disso.

Para resetar tudo:

- `openclaw.json` para configuração
- `credentials/` para perfis de autenticação e tokens
- `agents/<agentId>/sessions/` para histórico de sessões do agente
- `agents/<agentId>/sessions.json` para o índice de sessões
- `sessions/` se caminhos legados existirem
- `workspace/` se você quiser um workspace em branco

Se você quiser apenas resetar as sessões, exclua `agents/<agentId>/sessions/` e `agents/<agentId>/sessions.json` para esse agente. Mantenha `credentials/` se você não quiser se reautenticar.

## Referências

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
