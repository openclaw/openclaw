---
summary: "Refatoração do Clawnet: unificar protocolo de rede, papéis, autenticação, aprovações e identidade"
read_when:
  - Planejar um protocolo de rede unificado para nós + clientes operadores
  - Retrabalhar aprovações, pareamento, TLS e presença entre dispositivos
title: "Refatoração do Clawnet"
---

# Refatoração do Clawnet (unificação de protocolo + autenticação)

## Oi

Oi Peter — ótima direção; isso destrava uma UX mais simples + segurança mais forte.

## Propósito

Documento único e rigoroso para:

- Estado atual: protocolos, fluxos, limites de confiança.
- Pontos problemáticos: aprovações, roteamento multi‑salto, duplicação de UI.
- Novo estado proposto: um protocolo, papéis com escopo, autenticação/pareamento unificados, pinagem de TLS.
- Modelo de identidade: IDs estáveis + slugs simpáticos.
- Plano de migração, riscos e questões em aberto.

## Objetivos (da discussão)

- Um protocolo para todos os clientes (app mac, CLI, iOS, Android, nó headless).
- Todo participante da rede autenticado + pareado.
- Clareza de papéis: nós vs operadores.
- Aprovações centralizadas roteadas para onde o usuário está.
- Criptografia TLS + pinagem opcional para todo tráfego remoto.
- Duplicação mínima de código.
- Uma única máquina deve aparecer uma vez (sem entrada duplicada de UI/nó).

## Não‑objetivos (explícitos)

- Remover separação de capacidades (ainda é necessário privilégio mínimo).
- Expor o plano de controle completo do gateway sem verificações de escopo.
- Fazer a autenticação depender de rótulos humanos (slugs continuam não sendo segurança).

---

# Estado atual (como está)

## Dois protocolos

### 1. Gateway WebSocket (plano de controle)

- Superfície completa de API: configuração, canais, modelos, sessões, execuções de agente, logs, nós, etc.
- Bind padrão: loopback. Acesso remoto via SSH/Tailscale.
- Autenticação: token/senha via `connect`.
- Sem pinagem de TLS (depende de loopback/túnel).
- Código:
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2. Bridge (transporte de nós)

- Superfície restrita por lista de permissões, identidade do nó + pareamento.
- JSONL sobre TCP; TLS opcional + pinagem de impressão digital do certificado.
- TLS anuncia a impressão digital no TXT de descoberta.
- Código:
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## Clientes do plano de controle hoje

- CLI → Gateway WS via `callGateway` (`src/gateway/call.ts`).
- UI do app macOS → Gateway WS (`GatewayConnection`).
- Web Control UI → Gateway WS.
- ACP → Gateway WS.
- O controle via navegador usa seu próprio servidor HTTP de controle.

## Nós hoje

- App macOS em modo nó conecta ao bridge do Gateway (`MacNodeBridgeSession`).
- Apps iOS/Android conectam ao bridge do Gateway.
- Pareamento + token por nó armazenados no gateway.

## Fluxo atual de aprovação (exec)

- Agente usa `system.run` via Gateway.
- Gateway invoca o nó pelo bridge.
- O runtime do nó decide a aprovação.
- Prompt de UI mostrado pelo app mac (quando nó == app mac).
- Nó retorna `invoke-res` ao Gateway.
- Multi‑salto, UI atrelada ao host do nó.

## Presença + identidade hoje

- Entradas de presença do Gateway vindas de clientes WS.
- Entradas de presença de nós vindas do bridge.
- App mac pode mostrar duas entradas para a mesma máquina (UI + nó).
- Identidade do nó armazenada no repositório de pareamento; identidade da UI separada.

---

# Problemas / pontos de dor

- Dois stacks de protocolo para manter (WS + Bridge).
- Aprovações em nós remotos: o prompt aparece no host do nó, não onde o usuário está.
- Pinagem de TLS existe apenas no bridge; WS depende de SSH/Tailscale.
- Duplicação de identidade: a mesma máquina aparece como múltiplas instâncias.
- Papéis ambíguos: capacidades de UI + nó + CLI não claramente separadas.

---

# Novo estado proposto (Clawnet)

## Um protocolo, dois papéis

Protocolo WS único com papel + escopo.

- **Papel: nó** (host de capacidades)
- **Papel: operador** (plano de controle)
- **Escopo** opcional para operador:
  - `operator.read` (status + visualização)
  - `operator.write` (execução de agente, envios)
  - `operator.admin` (configuração, canais, modelos)

### Comportamentos por papel

**Nó**

- Pode registrar capacidades (`caps`, `commands`, permissões).
- Pode receber comandos `invoke` (`system.run`, `camera.*`, `canvas.*`, `screen.record`, etc).
- Pode enviar eventos: `voice.transcript`, `agent.request`, `chat.subscribe`.
- Não pode chamar APIs do plano de controle de config/modelos/canais/sessões/agentes.

**Operador**

- API completa do plano de controle, protegida por escopo.
- Recebe todas as aprovações.
- Não executa diretamente as ações do SA; rotas para nós.

### Regra chave

O papel é por conexão, não por dispositivo. Um dispositivo pode abrir ambos os papéis, separadamente.

---

# Autenticação + pareamento unificados

## Identidade do cliente

Todo cliente fornece:

- `deviceId` (estável, derivado da chave do dispositivo).
- `displayName` (nome humano).
- `role` + `scope` + `caps` + `commands`.

## Fluxo de pareamento (unificado)

- Cliente conecta sem autenticação.
- Gateway cria uma **solicitação de pareamento** para esse `deviceId`.
- Operador recebe prompt; aprova/nega.
- Gateway emite credenciais vinculadas a:
  - chave pública do dispositivo
  - papel(is)
  - escopo(s)
  - capacidades/comandos
- Cliente persiste o token e reconecta autenticado.

## Autenticação vinculada ao dispositivo (evitar replay de bearer token)

Preferido: pares de chaves do dispositivo.

- Dispositivo gera um par de chaves uma vez.
- `deviceId = fingerprint(publicKey)`.
- Gateway envia nonce; dispositivo assina; gateway verifica.
- Tokens são emitidos para uma chave pública (prova de posse), não para uma string.

Alternativas:

- mTLS (certificados de cliente): mais forte, mais complexidade operacional.
- Bearer tokens de curta duração apenas como fase temporária (rotacionar + revogar cedo).

## Aprovação silenciosa (heurística SSH)

Definir com precisão para evitar um elo fraco. Preferir uma:

- **Somente local**: auto‑parear quando o cliente conecta via loopback/Unix socket.
- **Desafio via SSH**: gateway emite nonce; cliente prova SSH ao buscá‑lo.
- **Janela de presença física**: após uma aprovação local na UI do host do gateway, permitir auto‑pareamento por uma janela curta (ex.: 10 minutos).

Sempre registrar em log + registrar auto‑aprovações.

---

# TLS em todo lugar (dev + prod)

## Reutilizar o TLS existente do bridge

Usar o runtime TLS atual + pinagem de impressão digital:

- `src/infra/bridge/server/tls.ts`
- lógica de verificação de impressão digital em `src/node-host/bridge-client.ts`

## Aplicar ao WS

- Servidor WS suporta TLS com o mesmo cert/chave + impressão digital.
- Clientes WS podem fixar a impressão digital (opcional).
- Descoberta anuncia TLS + impressão digital para todos os endpoints.
  - Descoberta é apenas dica de localização; nunca uma âncora de confiança.

## Por quê

- Reduzir dependência de SSH/Tailscale para confidencialidade.
- Tornar conexões móveis remotas seguras por padrão.

---

# Redesenho de aprovações (centralizado)

## Atual

A aprovação acontece no host do nó (runtime do nó no app mac). O prompt aparece onde o nó roda.

## Proposto

A aprovação é **hospedada no gateway**, com UI entregue aos clientes operadores.

### Novo fluxo

1. Gateway recebe intenção `system.run` (agente).
2. Gateway cria registro de aprovação: `approval.requested`.
3. UIs de operador mostram o prompt.
4. Decisão de aprovação enviada ao gateway: `approval.resolve`.
5. Gateway invoca o comando do nó se aprovado.
6. Nó executa e retorna `invoke-res`.

### Semântica de aprovação (endurecimento)

- Broadcast para todos os operadores; apenas a UI ativa mostra modal (as outras recebem um toast).
- A primeira resolução vence; o gateway rejeita resoluções subsequentes como já resolvidas.
- Timeout padrão: negar após N segundos (ex.: 60s), registrar motivo.
- Resolução requer escopo `operator.approvals`.

## Benefícios

- O prompt aparece onde o usuário está (mac/celular).
- Aprovações consistentes para nós remotos.
- Runtime do nó permanece headless; sem dependência de UI.

---

# Exemplos de clareza de papéis

## App para iPhone

- **Papel de nó** para: microfone, câmera, chat de voz, localização, push‑to‑talk.
- **operator.read** opcional para status e visualização de chat.
- **operator.write/admin** opcional apenas quando explicitamente habilitado.

## App macOS

- Papel de operador por padrão (UI de controle).
- Papel de nó quando “Nó do Mac” está habilitado (system.run, tela, câmera).
- Mesmo deviceId para ambas as conexões → entrada de UI mesclada.

## CLI

- Sempre papel de operador.
- Escopo derivado do subcomando:
  - `status`, `logs` → read
  - `agent`, `message` → write
  - `config`, `channels` → admin
  - aprovações + pareamento → `operator.approvals` / `operator.pairing`

---

# Identidade + slugs

## ID estável

Obrigatório para autenticação; nunca muda.
Preferido:

- Impressão digital do par de chaves (hash da chave pública).

## Slug simpático (tema de lagosta)

Apenas rótulo humano.

- Exemplo: `scarlet-claw`, `saltwave`, `mantis-pinch`.
- Armazenado no registro do gateway, editável.
- Tratamento de colisão: `-2`, `-3`.

## Agrupamento na UI

Mesmo `deviceId` entre papéis → uma única linha de “Instância”:

- Badge: `operator`, `node`.
- Mostra capacidades + último visto.

---

# Estratégia de migração

## Fase 0: Documentar + alinhar

- Publicar este documento.
- Inventariar todas as chamadas de protocolo + fluxos de aprovação.

## Fase 1: Adicionar papéis/escopos ao WS

- Estender parâmetros `connect` com `role`, `scope`, `deviceId`.
- Adicionar controle por lista de permissões para papel de nó.

## Fase 2: Compatibilidade do bridge

- Manter o bridge em execução.
- Adicionar suporte a nó via WS em paralelo.
- Proteger recursos atrás de flag de configuração.

## Fase 3: Aprovações centralizadas

- Adicionar eventos de solicitação + resolução de aprovação no WS.
- Atualizar UI do app mac para solicitar + responder.
- Runtime do nó para de exibir prompts de UI.

## Fase 4: Unificação de TLS

- Adicionar configuração de TLS para WS usando o runtime TLS do bridge.
- Adicionar pinagem aos clientes.

## Fase 5: Deprecar o bridge

- Migrar iOS/Android/mac nó para WS.
- Manter o bridge como fallback; remover quando estável.

## Fase 6: Autenticação vinculada ao dispositivo

- Exigir identidade baseada em chave para todas as conexões não locais.
- Adicionar UI de revogação + rotação.

---

# Notas de segurança

- Papéis/lista de permissões aplicados no limite do gateway.
- Nenhum cliente recebe API “completa” sem escopo de operador.
- Pareamento exigido para _todas_ as conexões.
- TLS + pinagem reduzem risco de MITM para mobile.
- Aprovação silenciosa via SSH é conveniência; ainda registrada + revogável.
- Descoberta nunca é uma âncora de confiança.
- Declarações de capacidade são verificadas contra listas de permissões do servidor por plataforma/tipo.

# Streaming + payloads grandes (mídia do nó)

O plano de controle WS é adequado para mensagens pequenas, mas os nós também fazem:

- clipes de câmera
- gravações de tela
- streams de áudio

Opções:

1. Frames binários WS + chunking + regras de backpressure.
2. Endpoint de streaming separado (ainda com TLS + autenticação).
3. Manter o bridge por mais tempo para comandos pesados de mídia; migrar por último.

Escolha uma antes da implementação para evitar deriva.

# Política de capacidade + comando

- Capacidades/comandos reportados pelo nó são tratados como **alegações**.
- O gateway aplica listas de permissões por plataforma.
- Qualquer novo comando requer aprovação do operador ou mudança explícita na lista de permissões.
- Auditar mudanças com timestamps.

# Auditoria + rate limiting

- Registrar: solicitações de pareamento, aprovações/negações, emissão/rotação/revogação de tokens.
- Limitar taxa de spam de pareamento e prompts de aprovação.

# Higiene de protocolo

- Versão explícita do protocolo + códigos de erro.
- Regras de reconexão + política de heartbeat.
- TTL de presença e semântica de último visto.

---

# Questões em aberto

1. Dispositivo único executando ambos os papéis: modelo de token
   - Recomendar tokens separados por papel (nó vs operador).
   - Mesmo deviceId; escopos diferentes; revogação mais clara.

2. Granularidade de escopo do operador
   - read/write/admin + aprovações + pareamento (mínimo viável).
   - Considerar escopos por recurso depois.

3. UX de rotação + revogação de token
   - Auto‑rotacionar ao mudar papel.
   - UI para revogar por deviceId + papel.

4. Descoberta
   - Estender o TXT Bonjour atual para incluir impressão digital TLS do WS + dicas de papel.
   - Tratar apenas como dicas de localização.

5. Aprovação entre redes
   - Broadcast para todos os clientes operadores; UI ativa mostra modal.
   - Primeira resposta vence; gateway impõe atomicidade.

---

# Resumo (TL;DR)

- Hoje: plano de controle WS + transporte de nós via Bridge.
- Dor: aprovações + duplicação + dois stacks.
- Proposta: um protocolo WS com papéis + escopos explícitos, pareamento unificado + pinagem de TLS, aprovações hospedadas no gateway, IDs de dispositivo estáveis + slugs simpáticos.
- Resultado: UX mais simples, segurança mais forte, menos duplicação, melhor roteamento móvel.
