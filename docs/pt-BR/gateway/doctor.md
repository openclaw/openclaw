---
summary: "Comando Doctor: verificações de saúde, migrações de configuração e etapas de reparo"
read_when:
  - Ao adicionar ou modificar migrações do doctor
  - Ao introduzir mudanças de configuração incompatíveis
title: "Doctor"
---

# Doctor

`openclaw doctor` é a ferramenta de reparo + migração do OpenClaw. Ela corrige
configurações/estado obsoletos, verifica a saúde e fornece etapas de reparo acionáveis.

## Início rápido

```bash
openclaw doctor
```

### Headless / automação

```bash
openclaw doctor --yes
```

Aceita os padrões sem solicitar confirmação (incluindo etapas de reparo de reinício/serviço/sandbox quando aplicável).

```bash
openclaw doctor --repair
```

Aplica os reparos recomendados sem solicitar confirmação (reparos + reinícios quando seguro).

```bash
openclaw doctor --repair --force
```

Aplica também reparos agressivos (sobrescreve configurações personalizadas do supervisor).

```bash
openclaw doctor --non-interactive
```

Executa sem prompts e aplica apenas migrações seguras (normalização de configuração + movimentações de estado em disco). Ignora ações de reinício/serviço/sandbox que exigem confirmação humana.
Migrações de estado legado são executadas automaticamente quando detectadas.

```bash
openclaw doctor --deep
```

Varre serviços do sistema em busca de instalações extras do gateway (launchd/systemd/schtasks).

Se você quiser revisar as alterações antes de gravar, abra primeiro o arquivo de configuração:

```bash
cat ~/.openclaw/openclaw.json
```

## O que ele faz (resumo)

- Atualização opcional pré-execução para instalações via git (somente interativo).
- Verificação de atualização do protocolo da UI (reconstrói a Control UI quando o esquema do protocolo é mais novo).
- Verificação de saúde + prompt de reinício.
- Resumo do status das Skills (elegíveis/ausentes/bloqueadas).
- Normalização de configuração para valores legados.
- Avisos de sobrescrita do provedor OpenCode Zen (`models.providers.opencode`).
- Migração de estado legado em disco (sessões/diretório do agente/autenticação do WhatsApp).
- Verificações de integridade e permissões do estado (sessões, transcrições, diretório de estado).
- Verificações de permissão do arquivo de configuração (chmod 600) ao executar localmente.
- Saúde de autenticação de modelos: verifica expiração de OAuth, pode atualizar tokens prestes a expirar e relata estados de cooldown/desativado do perfil de autenticação.
- Detecção de diretório de workspace extra (`~/openclaw`).
- Reparo de imagem de sandbox quando sandboxing está habilitado.
- Migração de serviços legados e detecção de gateways extras.
- Verificações de runtime do Gateway (serviço instalado, mas não em execução; rótulo launchd em cache).
- Avisos de status de canais (sondados a partir do gateway em execução).
- Auditoria de configuração do supervisor (launchd/systemd/schtasks) com reparo opcional.
- Verificações de melhores práticas de runtime do Gateway (Node vs Bun, caminhos de gerenciadores de versão).
- Diagnósticos de colisão de porta do Gateway (padrão `18789`).
- Avisos de segurança para políticas de DM abertas.
- Avisos de autenticação do Gateway quando nenhum `gateway.auth.token` está definido (modo local; oferece geração de token).
- Verificação de linger do systemd no Linux.
- Verificações de instalação a partir do código-fonte (incompatibilidade de workspace do pnpm, ativos de UI ausentes, binário tsx ausente).
- Grava configuração atualizada + metadados do assistente.

## Comportamento detalhado e justificativa

### 0. Atualização opcional (instalações via git)

Se isto for um checkout git e o doctor estiver sendo executado de forma interativa, ele oferece
atualizar (fetch/rebase/build) antes de executar o doctor.

### 1. Normalização de configuração

Se a configuração contiver formatos de valores legados (por exemplo `messages.ackReaction`
sem uma sobrescrita específica por canal), o doctor os normaliza para o esquema atual.

### 2. Migrações de chaves de configuração legadas

Quando a configuração contém chaves obsoletas, outros comandos se recusam a executar e pedem
que você execute `openclaw doctor`.

O Doctor irá:

- Explicar quais chaves legadas foram encontradas.
- Mostrar a migração aplicada.
- Reescrever `~/.openclaw/openclaw.json` com o esquema atualizado.

O Gateway também executa automaticamente as migrações do doctor na inicialização quando detecta
um formato de configuração legado, para que configurações obsoletas sejam reparadas sem intervenção manual.

Migrações atuais:

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → nível superior `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) Sobrescritas do provedor OpenCode Zen

Se você adicionou `models.providers.opencode` (ou `opencode-zen`) manualmente, isso
sobrescreve o catálogo OpenCode Zen integrado de `@mariozechner/pi-ai`. Isso pode
forçar todos os modelos a usar uma única API ou zerar custos. O Doctor emite um aviso
para que você possa remover a sobrescrita e restaurar o roteamento de API + custos por modelo.

### 3. Migrações de estado legado (layout em disco)

O Doctor pode migrar layouts antigos em disco para a estrutura atual:

- Armazenamento de sessões + transcrições:
  - de `~/.openclaw/sessions/` para `~/.openclaw/agents/<agentId>/sessions/`
- Diretório do agente:
  - de `~/.openclaw/agent/` para `~/.openclaw/agents/<agentId>/agent/`
- Estado de autenticação do WhatsApp (Baileys):
  - de `~/.openclaw/credentials/*.json` legado (exceto `oauth.json`)
  - para `~/.openclaw/credentials/whatsapp/<accountId>/...` (id de conta padrão: `default`)

Essas migrações são best-effort e idempotentes; o doctor emitirá avisos quando
deixar pastas legadas como backups. O Gateway/CLI também migra automaticamente
as sessões legadas + diretório do agente na inicialização para que histórico/autenticação/modelos
caiam no caminho por agente sem uma execução manual do doctor. A autenticação do WhatsApp é
intencionalmente migrada apenas via `openclaw doctor`.

### 4. Verificações de integridade do estado (persistência de sessão, roteamento e segurança)

O diretório de estado é o tronco operacional. Se ele desaparecer, você perde
sessões, credenciais, logs e configuração (a menos que tenha backups em outro lugar).

O Doctor verifica:

- **Diretório de estado ausente**: avisa sobre perda catastrófica de estado, solicita recriar
  o diretório e lembra que não pode recuperar dados ausentes.
- **Permissões do diretório de estado**: verifica capacidade de escrita; oferece reparar permissões
  (e emite uma dica `chown` quando é detectada incompatibilidade de proprietário/grupo).
- **Diretórios de sessão ausentes**: `sessions/` e o diretório de armazenamento de sessões são
  necessários para persistir histórico e evitar falhas `ENOENT`.
- **Incompatibilidade de transcrição**: avisa quando entradas recentes de sessão têm arquivos de
  transcrição ausentes.
- **Sessão principal “JSONL de 1 linha”**: sinaliza quando a transcrição principal tem apenas uma
  linha (o histórico não está acumulando).
- **Múltiplos diretórios de estado**: avisa quando existem várias pastas `~/.openclaw` em
  diretórios home diferentes ou quando `OPENCLAW_STATE_DIR` aponta para outro local (o histórico pode
  se dividir entre instalações).
- **Lembrete de modo remoto**: se `gateway.mode=remote`, o doctor lembra você de executá-lo
  no host remoto (o estado vive lá).
- **Permissões do arquivo de configuração**: avisa se `~/.openclaw/openclaw.json` é legível por
  grupo/mundo e oferece restringir para `600`.

### 5. Saúde de autenticação de modelos (expiração de OAuth)

O Doctor inspeciona perfis OAuth no armazenamento de autenticação, avisa quando tokens estão
expirando/expirados e pode atualizá-los quando seguro. Se o perfil Anthropic Claude Code estiver
obsoleto, ele sugere executar `claude setup-token` (ou colar um setup-token).
Prompts de atualização só aparecem quando executado de forma interativa (TTY); `--non-interactive`
ignora tentativas de atualização.

O Doctor também relata perfis de autenticação que estão temporariamente inutilizáveis devido a:

- cooldowns curtos (rate limits/timeouts/falhas de autenticação)
- desativações mais longas (falhas de faturamento/crédito)

### 6. Validação do modelo de Hooks

Se `hooks.gmail.model` estiver definido, o doctor valida a referência do modelo contra o
catálogo e a lista de permissões e avisa quando não resolverá ou não é permitido.

### 7. Reparo de imagem de sandbox

Quando sandboxing está habilitado, o doctor verifica imagens Docker e oferece construir ou
alternar para nomes legados se a imagem atual estiver ausente.

### 8. Migrações de serviços do Gateway e dicas de limpeza

O Doctor detecta serviços legados do gateway (launchd/systemd/schtasks) e
oferece removê-los e instalar o serviço OpenClaw usando a porta atual do gateway. Ele também pode varrer serviços semelhantes a gateways extras e imprimir dicas de limpeza.
Serviços do gateway OpenClaw nomeados por perfil são considerados de primeira classe e não
são sinalizados como “extras”.

### 9. Avisos de segurança

O Doctor emite avisos quando um provedor está aberto a DMs sem uma lista de permissões, ou
quando uma política está configurada de forma perigosa.

### 10. systemd linger (Linux)

Se estiver executando como um serviço de usuário do systemd, o doctor garante que o linger
esteja habilitado para que o gateway permaneça ativo após o logout.

### 11. Status das Skills

O Doctor imprime um resumo rápido de Skills elegíveis/ausentes/bloqueadas para o workspace atual.

### 12. Verificações de autenticação do Gateway (token local)

O Doctor avisa quando `gateway.auth` está ausente em um gateway local e oferece gerar um token. Use `openclaw doctor --generate-gateway-token` para forçar a criação de token em automação.

### 13. Verificação de saúde do Gateway + reinício

O Doctor executa uma verificação de saúde e oferece reiniciar o gateway quando ele parece
não saudável.

### 14. Avisos de status de canais

Se o gateway estiver saudável, o doctor executa uma sondagem de status de canais e relata
avisos com correções sugeridas.

### 15. Auditoria + reparo da configuração do supervisor

O Doctor verifica a configuração instalada do supervisor (launchd/systemd/schtasks) quanto a
padrões ausentes ou desatualizados (por exemplo, dependências network-online do systemd e
atraso de reinício). Quando encontra uma divergência, recomenda uma atualização e pode
reescrever o arquivo de serviço/tarefa para os padrões atuais.

Notas:

- `openclaw doctor` solicita confirmação antes de reescrever a configuração do supervisor.
- `openclaw doctor --yes` aceita os prompts de reparo padrão.
- `openclaw doctor --repair` aplica correções recomendadas sem prompts.
- `openclaw doctor --repair --force` sobrescreve configurações personalizadas do supervisor.
- Você sempre pode forçar uma regravação completa via `openclaw gateway install --force`.

### 16. Diagnósticos de runtime + porta do Gateway

O Doctor inspeciona o runtime do serviço (PID, último status de saída) e avisa quando o
serviço está instalado, mas não está realmente em execução. Ele também verifica colisões
de porta na porta do gateway (padrão `18789`) e relata causas prováveis (gateway já
em execução, túnel SSH).

### 17. Melhores práticas de runtime do Gateway

O Doctor avisa quando o serviço do gateway é executado em Bun ou em um caminho de Node
gerenciado por versões (`nvm`, `fnm`, `volta`, `asdf`, etc.). Canais de WhatsApp + Telegram exigem Node,
e caminhos de gerenciadores de versão podem quebrar após upgrades porque o serviço não
carrega o init do shell. O Doctor oferece migrar para uma instalação de Node do sistema
quando disponível (Homebrew/apt/choco).

### 18. Gravação de configuração + metadados do assistente

O Doctor persiste quaisquer alterações de configuração e registra metadados do assistente
para registrar a execução do doctor.

### 19. Dicas de workspace (backup + sistema de memória)

O Doctor sugere um sistema de memória de workspace quando ausente e imprime uma dica de
backup se o workspace ainda não estiver sob git.

Veja [/concepts/agent-workspace](/concepts/agent-workspace) para um guia completo sobre
estrutura de workspace e backup com git (recomendado GitHub ou GitLab privados).
