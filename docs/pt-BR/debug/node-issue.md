---
summary: Notas e soluções alternativas para falha do Node + tsx "__name is not a function"
read_when:
  - Depuração de scripts de desenvolvimento apenas com Node ou falhas no modo watch
  - Investigação de falhas do loader tsx/esbuild no OpenClaw
title: "Falha do Node + tsx"
---

# Falha do Node + tsx "\_\_name is not a function"

## Resumo

Executar o OpenClaw via Node com `tsx` falha na inicialização com:

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

Isso começou após a troca dos scripts de desenvolvimento de Bun para `tsx` (commit `2871657e`, 2026-01-06). O mesmo caminho de runtime funcionava com Bun.

## Ambiente

- Node: v25.x (observado no v25.3.0)
- tsx: 4.21.0
- SO: macOS (a reprodução também é provável em outras plataformas que executam Node 25)

## Reprodução (apenas Node)

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## Reprodução mínima no repositório

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Verificação de versão do Node

- Node 25.3.0: falha
- Node 22.22.0 (Homebrew `node@22`): falha
- Node 24: ainda não instalado aqui; precisa de verificação

## Notas / hipótese

- `tsx` usa esbuild para transformar TS/ESM. O `keepNames` do esbuild emite um helper `__name` e envolve definições de função com `__name(...)`.
- A falha indica que `__name` existe, mas não é uma função em tempo de execução, o que implica que o helper está ausente ou foi sobrescrito para este módulo no caminho do loader do Node 25.
- Problemas semelhantes com o helper `__name` foram relatados em outros consumidores do esbuild quando o helper está ausente ou é reescrito.

## Histórico de regressão

- `2871657e` (2026-01-06): scripts alterados de Bun para tsx para tornar o Bun opcional.
- Antes disso (caminho com Bun), `openclaw status` e `gateway:watch` funcionavam.

## Soluções alternativas

- Usar Bun para scripts de desenvolvimento (reversão temporária atual).

- Usar Node + tsc em watch e, em seguida, executar a saída compilada:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- Confirmado localmente: `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` funciona no Node 25.

- Desabilitar keepNames do esbuild no loader TS, se possível (evita a inserção do helper `__name`); o tsx atualmente não expõe isso.

- Testar o Node LTS (22/24) com `tsx` para ver se o problema é específico do Node 25.

## Referências

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## Próximos passos

- Reproduzir no Node 22/24 para confirmar regressão no Node 25.
- Testar `tsx` nightly ou fixar em uma versão anterior se existir uma regressão conhecida.
- Se reproduzir no Node LTS, abrir um repro mínimo upstream com o stack trace `__name`.
