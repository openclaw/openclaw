---
title: Verificação Formal (Modelos de Segurança)
summary: Modelos de segurança verificados por máquina para os caminhos de maior risco do OpenClaw.
permalink: /security/formal-verification/
x-i18n:
  source_path: security/formal-verification.md
  source_hash: 8dff6ea41a37fb6b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:32:14Z
---

# Verificação Formal (Modelos de Segurança)

Esta página acompanha os **modelos formais de segurança** do OpenClaw (TLA+/TLC hoje; mais conforme necessário).

> Nota: alguns links mais antigos podem se referir ao nome anterior do projeto.

**Objetivo (north star):** fornecer um argumento verificado por máquina de que o OpenClaw impõe sua
política de segurança pretendida (autorização, isolamento de sessão, bloqueio de ferramentas e
segurança contra má configuração), sob pressupostos explícitos.

**O que isto é (hoje):** uma **suíte de regressão de segurança** executável e orientada por atacantes:

- Cada afirmação tem uma verificação executável por model checking sobre um espaço de estados finito.
- Muitas afirmações têm um **modelo negativo** pareado que produz um rastro de contraexemplo para uma classe realista de bugs.

**O que isto não é (ainda):** uma prova de que “o OpenClaw é seguro em todos os aspectos” ou de que a implementação completa em TypeScript está correta.

## Onde os modelos vivem

Os modelos são mantidos em um repositório separado: [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models).

## Observações importantes

- Estes são **modelos**, não a implementação completa em TypeScript. Pode haver divergência entre modelo e código.
- Os resultados são limitados pelo espaço de estados explorado pelo TLC; “verde” não implica segurança além dos pressupostos e limites modelados.
- Algumas afirmações dependem de pressupostos ambientais explícitos (por exemplo, implantação correta, entradas de configuração corretas).

## Reproduzindo resultados

Hoje, os resultados são reproduzidos clonando o repositório de modelos localmente e executando o TLC (veja abaixo). Uma iteração futura poderia oferecer:

- modelos executados em CI com artefatos públicos (rastros de contraexemplo, logs de execução)
- um fluxo de trabalho hospedado de “execute este modelo” para verificações pequenas e limitadas

Primeiros passos:

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ required (TLC runs on the JVM).
# The repo vendors a pinned `tla2tools.jar` (TLA+ tools) and provides `bin/tlc` + Make targets.

make <target>
```

### Exposição do Gateway e má configuração de gateway aberto

**Afirmação:** vincular além do loopback sem autenticação pode possibilitar comprometimento remoto / aumenta a exposição; token/senha bloqueia atacantes não autenticados (segundo os pressupostos do modelo).

- Execuções verdes:
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- Vermelho (esperado):
  - `make gateway-exposure-v2-negative`

Veja também: `docs/gateway-exposure-matrix.md` no repositório de modelos.

### Pipeline Nodes.run (capacidade de maior risco)

**Afirmação:** `nodes.run` exige (a) lista de permissões de comandos de nó mais comandos declarados e (b) aprovação ao vivo quando configurado; as aprovações são tokenizadas para evitar replay (no modelo).

- Execuções verdes:
  - `make nodes-pipeline`
  - `make approvals-token`
- Vermelho (esperado):
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### Armazenamento de pareamento (bloqueio de DM)

**Afirmação:** solicitações de pareamento respeitam TTL e limites de solicitações pendentes.

- Execuções verdes:
  - `make pairing`
  - `make pairing-cap`
- Vermelho (esperado):
  - `make pairing-negative`
  - `make pairing-cap-negative`

### Bloqueio de entrada (menções + bypass de comando de controle)

**Afirmação:** em contextos de grupo que exigem menção, um “comando de controle” não autorizado não pode contornar o bloqueio por menção.

- Verde:
  - `make ingress-gating`
- Vermelho (esperado):
  - `make ingress-gating-negative`

### Roteamento/isolamento de chave de sessão

**Afirmação:** DMs de pares distintos não colapsam na mesma sessão, a menos que explicitamente vinculadas/configuradas.

- Verde:
  - `make routing-isolation`
- Vermelho (esperado):
  - `make routing-isolation-negative`

## v1++: modelos adicionais limitados (concorrência, tentativas, correção de rastros)

Estes são modelos de acompanhamento que aumentam a fidelidade em torno de modos de falha do mundo real (atualizações não atômicas, tentativas e fan-out de mensagens).

### Concorrência / idempotência do armazenamento de pareamento

**Afirmação:** um armazenamento de pareamento deve impor `MaxPending` e idempotência mesmo sob interleavings (ou seja, “verificar-e-gravar” deve ser atômico / bloqueado; a atualização não deve criar duplicatas).

O que isso significa:

- Sob solicitações concorrentes, não é possível exceder `MaxPending` para um canal.
- Solicitações/atualizações repetidas para o mesmo `(channel, sender)` não devem criar linhas pendentes ativas duplicadas.

- Execuções verdes:
  - `make pairing-race` (verificação de limite atômica/bloqueada)
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- Vermelho (esperado):
  - `make pairing-race-negative` (corrida de limite com begin/commit não atômico)
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### Correlação de rastros de entrada / idempotência

**Afirmação:** a ingestão deve preservar a correlação de rastros ao longo do fan-out e ser idempotente sob tentativas do provedor.

O que isso significa:

- Quando um evento externo se torna várias mensagens internas, cada parte mantém a mesma identidade de rastro/evento.
- Tentativas não resultam em processamento duplicado.
- Se IDs de evento do provedor estiverem ausentes, a desduplicação recorre a uma chave segura (por exemplo, ID de rastro) para evitar descartar eventos distintos.

- Verde:
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- Vermelho (esperado):
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### Precedência de dmScope no roteamento + identityLinks

**Afirmação:** o roteamento deve manter sessões de DM isoladas por padrão e colapsar sessões apenas quando explicitamente configurado (precedência de canal + identity links).

O que isso significa:

- Substituições de dmScope específicas do canal devem prevalecer sobre os padrões globais.
- identityLinks devem colapsar apenas dentro de grupos explicitamente vinculados, não entre pares não relacionados.

- Verde:
  - `make routing-precedence`
  - `make routing-identitylinks`
- Vermelho (esperado):
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
