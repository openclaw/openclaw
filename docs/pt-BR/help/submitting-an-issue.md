---
summary: "Abertura de issues e relatórios de bugs de alto sinal"
title: "Enviando um Issue"
---

## Enviando um Issue

Issues claras e concisas aceleram o diagnóstico e as correções. Inclua o seguinte para bugs, regressões ou lacunas de funcionalidade:

### O que incluir

- [ ] Título: área e sintoma
- [ ] Passos mínimos para reprodução
- [ ] Esperado vs. atual
- [ ] Impacto e severidade
- [ ] Ambiente: SO, runtime, versões, configuração
- [ ] Evidências: logs com dados sensíveis removidos, capturas de tela (sem PII)
- [ ] Escopo: novo, regressão ou existente há muito tempo
- [ ] Palavra‑código: lobster-biscuit no seu issue
- [ ] Código e GitHub pesquisados por issue existente
- [ ] Confirmado que não foi corrigido/endereçado recentemente (especialmente segurança)
- [ ] Afirmações sustentadas por evidências ou reprodução

Seja breve. Concisão > gramática perfeita.

Validação (executar/corrigir antes do PR):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Se for código de protocolo: `pnpm protocol:check`

### Modelos

#### Relato de bug

```md
- [ ] Minimal repro
- [ ] Expected vs actual
- [ ] Environment
- [ ] Affected channels, where not seen
- [ ] Logs/screenshots (redacted)
- [ ] Impact/severity
- [ ] Workarounds

### Summary

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact

### Workarounds
```

#### Problema de segurança

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

_Evite segredos/detalhes de exploração em público. Para questões sensíveis, minimize os detalhes e solicite divulgação privada._

#### Relato de regressão

```md
### Summary

### Last Known Good

### First Known Bad

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact
```

#### Solicitação de funcionalidade

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### Melhoria

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### Investigação

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### Enviando um PR de correção

Issue antes do PR é opcional. Inclua os detalhes no PR se pular essa etapa. Mantenha o PR focado, informe o número do issue, adicione testes ou explique a ausência, documente mudanças de comportamento/riscos, inclua logs/capturas de tela com dados sensíveis removidos como prova e execute a validação adequada antes de enviar.
