---
summary: "Como enviar um PR de alto sinal"
title: "Envio de um PR"
---

Bons PRs são fáceis de revisar: revisores devem entender rapidamente a intenção, verificar o comportamento e integrar as mudanças com segurança. Este guia aborda envios concisos e de alto sinal para revisão humana e por LLM.

## O que faz um bom PR

- [ ] Explique o problema, por que ele importa e a mudança.
- [ ] Mantenha as mudanças focadas. Evite refatorações amplas.
- [ ] Resuma mudanças visíveis ao usuario/de configuração/padrão.
- [ ] Liste a cobertura de testes, pulos e os motivos.
- [ ] Adicione evidências: logs, capturas de tela ou gravações (UI/UX).
- [ ] Palavra-código: coloque “lobster-biscuit” na descrição do PR se voce leu este guia.
- [ ] Execute/corrija os comandos `pnpm` relevantes antes de criar o PR.
- [ ] Pesquise no codebase e no GitHub por funcionalidades/issues/correções relacionadas.
- [ ] Baseie afirmações em evidências ou observação.
- [ ] Bom titulo: verbo + escopo + resultado (ex.: `Docs: add PR and issue templates`).

Seja conciso; revisão concisa > gramática. Omita quaisquer seções não aplicáveis.

### Comandos de validação de base (execute/corrija falhas para sua mudança)

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Mudanças de protocolo: `pnpm protocol:check`

## Divulgação progressiva

- Topo: resumo/intenção
- Em seguida: mudanças/riscos
- Em seguida: testes/verificação
- Por ultimo: implementação/evidências

## Tipos comuns de PR: especificidades

- [ ] Correção: Adicione repro, causa raiz, verificação.
- [ ] Funcionalidade: Adicione casos de uso, comportamento/demos/capturas (UI).
- [ ] Refatoração: Declare "sem mudança de comportamento", liste o que foi movido/simplificado.
- [ ] Chore: Declare o porquê (ex.: tempo de build, CI, dependências).
- [ ] Docs: Contexto antes/depois, link da pagina atualizada, execute `pnpm format`.
- [ ] Teste: Que lacuna é coberta; como evita regressões.
- [ ] Desempenho: Adicione métricas antes/depois e como foram medidas.
- [ ] UX/UI: Capturas de tela/video, observe impacto em acessibilidade.
- [ ] Infra/Build: Ambientes/validação.
- [ ] Segurança: Resuma risco, repro, verificação, sem dados sensíveis. Apenas afirmações fundamentadas.

## Checklist

- [ ] Problema/intenção claros
- [ ] Escopo focado
- [ ] Lista de mudanças de comportamento
- [ ] Lista e resultado dos testes
- [ ] Passos de teste manual (quando aplicável)
- [ ] Sem segredos/dados privados
- [ ] Baseado em evidências

## Template geral de PR

```md
#### Summary

#### Behavior Changes

#### Codebase and GitHub Search

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort (self-reported):
- Agent notes (optional, cite evidence):
```

## Templates por tipo de PR (substitua pelo seu tipo)

### Correção

```md
#### Summary

#### Repro Steps

#### Root Cause

#### Behavior Changes

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Funcionalidade

```md
#### Summary

#### Use Cases

#### Behavior Changes

#### Existing Functionality Check

- [ ] I searched the codebase for existing functionality.
      Searches performed (1-3 bullets):
  -
  -

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Refatoração

```md
#### Summary

#### Scope

#### No Behavior Change Statement

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Chore/Manutenção

```md
#### Summary

#### Why This Matters

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Docs

```md
#### Summary

#### Pages Updated

#### Before/After

#### Formatting

pnpm format

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Teste

```md
#### Summary

#### Gap Covered

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Perf

```md
#### Summary

#### Baseline

#### After

#### Measurement Method

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### UX/UI

```md
#### Summary

#### Screenshots or Video

#### Accessibility Impact

#### Tests

#### Manual Testing

### Prerequisites

-

### Steps

1.
2. **Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Infra/Build

```md
#### Summary

#### Environments Affected

#### Validation Steps

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Segurança

```md
#### Summary

#### Risk Summary

#### Repro Steps

#### Mitigation or Fix

#### Verification

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```
