---
summary: "Kit de testes: suítes unit/e2e/live, runners Docker e o que cada teste cobre"
read_when:
  - Executar testes localmente ou em CI
  - Adicionar regressões para bugs de modelo/provedor
  - Depurar comportamento do gateway + agente
title: "Testes"
---

# Testes

O OpenClaw tem três suítes Vitest (unit/integration, e2e, live) e um pequeno conjunto de runners Docker.

Este documento é um guia de “como testamos”:

- O que cada suíte cobre (e o que deliberadamente _não_ cobre)
- Quais comandos executar para fluxos de trabalho comuns (local, pré-push, depuração)
- Como os testes live descobrem credenciais e selecionam modelos/provedores
- Como adicionar regressões para problemas reais de modelo/provedor

## Início rápido

Na maioria dos dias:

- Gate completo (esperado antes do push): `pnpm build && pnpm check && pnpm test`

Quando você mexe em testes ou quer mais confiança:

- Gate de cobertura: `pnpm test:coverage`
- Suíte E2E: `pnpm test:e2e`

Ao depurar provedores/modelos reais (exige credenciais reais):

- Suíte live (modelos + sondas de ferramenta/imagem do gateway): `pnpm test:live`

Dica: quando você precisa apenas de um caso com falha, prefira restringir os testes live via as variáveis de ambiente de allowlist descritas abaixo.

## Suítes de teste (o que roda onde)

Pense nas suítes como “realismo crescente” (e aumento de instabilidade/custo):

### Unit / integration (padrão)

- Comando: `pnpm test`
- Configuração: `vitest.config.ts`
- Arquivos: `src/**/*.test.ts`
- Enquadramento:
  - Testes unitários puros
  - Testes de integração in-process (autenticação do gateway, roteamento, ferramentas, parsing, configuração)
  - Regressões determinísticas para bugs conhecidos
- Expectativas:
  - Roda em CI
  - Não requer chaves reais
  - Deve ser rápido e estável

### E2E (gateway smoke)

- Comando: `pnpm test:e2e`
- Configuração: `vitest.e2e.config.ts`
- Arquivos: `src/**/*.e2e.test.ts`
- Enquadramento:
  - Comportamento end-to-end do gateway com múltiplas instâncias
  - Superfícies WebSocket/HTTP, pareamento de nós e networking mais pesado
- Expectativas:
  - Roda em CI (quando habilitado no pipeline)
  - Não requer chaves reais
  - Mais partes móveis do que testes unitários (pode ser mais lento)

### Live (provedores reais + modelos reais)

- Comando: `pnpm test:live`
- Configuração: `vitest.live.config.ts`
- Arquivos: `src/**/*.live.test.ts`
- Padrão: **habilitado** por `pnpm test:live` (define `OPENCLAW_LIVE_TEST=1`)
- Enquadramento:
  - “Este provedor/modelo realmente funciona _hoje_ com credenciais reais?”
  - Capturar mudanças de formato do provedor, peculiaridades de tool-calling, problemas de autenticação e comportamento de rate limit
- Expectativas:
  - Não é estável para CI por design (redes reais, políticas reais do provedor, cotas, indisponibilidades)
  - Custa dinheiro / usa rate limits
  - Prefira rodar subconjuntos restritos em vez de “tudo”
  - Execuções live buscarão `~/.profile` para obter chaves de API ausentes
  - Rotação de chaves Anthropic: defina `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (ou `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) ou múltiplas variáveis `ANTHROPIC_API_KEY*`; os testes farão retry em rate limits

## Qual suíte eu deveria correr?

Use esta tabela de decisão:

- Editando lógica/testes: rode `pnpm test` (e `pnpm test:coverage` se você mudou bastante coisa)
- Tocando em networking do gateway / protocolo WS / pareamento: adicione `pnpm test:e2e`
- Depurando “meu bot está fora do ar” / falhas específicas de provedor / tool calling: rode um `pnpm test:live` restrito

## Live: smoke de modelos (chaves de perfil)

Os testes live são divididos em duas camadas para isolar falhas:

- “Modelo direto” nos diz se o provedor/modelo responde com a chave fornecida.
- “Gateway smoke” nos diz se o pipeline completo gateway+agente funciona para esse modelo (sessões, histórico, ferramentas, política de sandbox, etc.).

### Camada 1: conclusão direta do modelo (sem gateway)

- Teste: `src/agents/models.profiles.live.test.ts`
- Objetivo:
  - Enumerar modelos descobertos
  - Usar `getApiKeyForModel` para selecionar modelos para os quais você tem credenciais
  - Rodar uma pequena conclusão por modelo (e regressões direcionadas quando necessário)
- Como habilitar:
  - `pnpm test:live` (ou `OPENCLAW_LIVE_TEST=1` se chamar o Vitest diretamente)
- Defina `OPENCLAW_LIVE_MODELS=modern` (ou `all`, alias moderno) para realmente rodar esta suíte; caso contrário, ela é pulada para manter `pnpm test:live` focado no gateway smoke
- Como selecionar modelos:
  - `OPENCLAW_LIVE_MODELS=modern` para rodar a allowlist moderna (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` é um alias para a allowlist moderna
  - ou `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (allowlist separada por vírgulas)
- Como selecionar provedores:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (allowlist separada por vírgulas)
- De onde vêm as chaves:
  - Por padrão: store de perfis e fallbacks de ambiente
  - Defina `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` para impor **apenas store de perfis**
- Por que isso existe:
  - Separa “API do provedor está quebrada / chave inválida” de “pipeline do agente do gateway está quebrado”
  - Contém regressões pequenas e isoladas (exemplo: replay de reasoning + fluxos de tool-call do OpenAI Responses/Codex Responses)

### Camada 2: Gateway + agente de desenvolvimento (o que “@openclaw” realmente faz)

- Teste: `src/gateway/gateway-models.profiles.live.test.ts`
- Objetivo:
  - Subir um gateway in-process
  - Criar/atualizar uma sessão `agent:dev:*` (override de modelo por execução)
  - Iterar modelos-com-chaves e verificar:
    - resposta “significativa” (sem ferramentas)
    - uma invocação real de ferramenta funciona (sonda de leitura)
    - sondas extras opcionais de ferramentas (sonda exec+read)
    - caminhos de regressão do OpenAI (apenas tool-call → follow-up) continuam funcionando
- Detalhes das sondas (para explicar falhas rapidamente):
  - Sonda `read`: o teste escreve um arquivo nonce no workspace e pede ao agente para `read`-lo e ecoar o nonce de volta.
  - Sonda `exec+read`: o teste pede ao agente para `exec`-escrever um nonce em um arquivo temporário e depois `read`-lo de volta.
  - Sonda de imagem: o teste anexa um PNG gerado (gato + código aleatório) e espera que o modelo retorne `cat <CODE>`.
  - Referência de implementação: `src/gateway/gateway-models.profiles.live.test.ts` e `src/gateway/live-image-probe.ts`.
- Como habilitar:
  - `pnpm test:live` (ou `OPENCLAW_LIVE_TEST=1` se chamar o Vitest diretamente)
- Como selecionar modelos:
  - Padrão: allowlist moderna (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` é um alias para a allowlist moderna
  - Ou defina `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (ou lista separada por vírgulas) para restringir
- Como selecionar provedores (evite “OpenRouter tudo”):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (allowlist separada por vírgulas)
- Sondas de ferramenta + imagem estão sempre ativas neste teste live:
  - Sonda `read` + sonda `exec+read` (stress de ferramentas)
  - A sonda de imagem roda quando o modelo anuncia suporte a entrada de imagem
  - Fluxo (alto nível):
    - O teste gera um PNG minúsculo com “CAT” + código aleatório (`src/gateway/live-image-probe.ts`)
    - Envia via `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`
    - O Gateway faz parsing dos anexos em `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - O agente embutido encaminha uma mensagem de usuário multimodal ao modelo
    - Asserção: a resposta contém `cat` + o código (tolerância de OCR: pequenos erros permitidos)

Dica: para ver o que você pode testar na sua máquina (e os ids exatos de `provider/model`), execute:

```bash
openclaw models list
openclaw models list --json
```

## Live: smoke de setup-token Anthropic

- Teste: `src/agents/anthropic.setup-token.live.test.ts`
- Objetivo: verificar se o setup-token do Claude Code CLI (ou um perfil de setup-token colado) consegue completar um prompt Anthropic.
- Habilitar:
  - `pnpm test:live` (ou `OPENCLAW_LIVE_TEST=1` se chamar o Vitest diretamente)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- Fontes de token (escolha uma):
  - Perfil: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - Token bruto: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- Override de modelo (opcional):
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

Exemplo de setup:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## Live: smoke de backend CLI (Claude Code CLI ou outros CLIs locais)

- Teste: `src/gateway/gateway-cli-backend.live.test.ts`
- Objetivo: validar o pipeline Gateway + agente usando um backend CLI local, sem tocar na sua configuração padrão.
- Habilitar:
  - `pnpm test:live` (ou `OPENCLAW_LIVE_TEST=1` se chamar o Vitest diretamente)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- Padrões:
  - Modelo: `claude-cli/claude-sonnet-4-5`
  - Comando: `claude`
  - Args: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- Overrides (opcional):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` para enviar um anexo de imagem real (os caminhos são injetados no prompt).
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` para passar caminhos de arquivos de imagem como args da CLI em vez de injeção no prompt.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (ou `"list"`) para controlar como os args de imagem são passados quando `IMAGE_ARG` está definido.
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` para enviar um segundo turno e validar o fluxo de retomada.
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` para manter a configuração MCP do Claude Code CLI habilitada (o padrão desabilita a config MCP com um arquivo temporário vazio).

Exemplo:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### Receitas live recomendadas

Allowlists explícitas e restritas são mais rápidas e menos instáveis:

- Modelo único, direto (sem gateway):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- Modelo único, gateway smoke:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Tool calling em vários provedores:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Foco Google (chave da API Gemini + Antigravity):
  - Gemini (chave de API): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

Notas:

- `google/...` usa a API Gemini (chave de API).
- `google-antigravity/...` usa a ponte OAuth Antigravity (endpoint de agente no estilo Cloud Code Assist).
- `google-gemini-cli/...` usa a CLI Gemini local na sua máquina (autenticação separada + peculiaridades de ferramentas).
- API Gemini vs CLI Gemini:
  - API: o OpenClaw chama a API Gemini hospedada do Google via HTTP (chave de API / autenticação por perfil); é isso que a maioria dos usuários quer dizer por “Gemini”.
  - CLI: o OpenClaw executa um binário `gemini` local; ele tem sua própria autenticação e pode se comportar de forma diferente (streaming/suporte a ferramentas/desalinhamento de versão).

## Live: matriz de modelos (o que cobrimos)

Não há uma “lista fixa de modelos em CI” (live é opt-in), mas estes são os modelos **recomendados** para cobrir regularmente em uma máquina de desenvolvimento com chaves.

### Conjunto smoke moderno (tool calling + imagem)

Este é o conjunto de “modelos comuns” que esperamos manter funcionando:

- OpenAI (não-Codex): `openai/gpt-5.2` (opcional: `openai/gpt-5.1`)
- OpenAI Codex: `openai-codex/gpt-5.3-codex` (opcional: `openai-codex/gpt-5.3-codex-codex`)
- Anthropic: `anthropic/claude-opus-4-6` (ou `anthropic/claude-sonnet-4-5`)
- Google (API Gemini): `google/gemini-3-pro-preview` e `google/gemini-3-flash-preview` (evite modelos Gemini 2.x mais antigos)
- Google (Antigravity): `google-antigravity/claude-opus-4-6-thinking` e `google-antigravity/gemini-3-flash`
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Execute gateway smoke com ferramentas + imagem:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### Baseline: tool calling (Read + Exec opcional)

Escolha pelo menos um por família de provedor:

- OpenAI: `openai/gpt-5.2` (ou `openai/gpt-5-mini`)
- Anthropic: `anthropic/claude-opus-4-6` (ou `anthropic/claude-sonnet-4-5`)
- Google: `google/gemini-3-flash-preview` (ou `google/gemini-3-pro-preview`)
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Cobertura adicional opcional (bom ter):

- xAI: `xai/grok-4` (ou o mais recente disponível)
- Mistral: `mistral/`… (escolha um modelo “tools” que você tenha habilitado)
- Cerebras: `cerebras/`… (se você tiver acesso)
- LM Studio: `lmstudio/`… (local; tool calling depende do modo da API)

### Visão: envio de imagem (anexo → mensagem multimodal)

Inclua pelo menos um modelo com capacidade de imagem em `OPENCLAW_LIVE_GATEWAY_MODELS` (variantes do Claude/Gemini/OpenAI com visão, etc.) para exercitar a sonda de imagem.

### Agregadores / gateways alternativos

Se você tiver chaves habilitadas, também suportamos testes via:

- OpenRouter: `openrouter/...` (centenas de modelos; use `openclaw models scan` para encontrar candidatos com ferramentas+imagem)
- OpenCode Zen: `opencode/...` (autenticação via `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

Mais provedores que você pode incluir na matriz live (se tiver credenciais/configuração):

- Integrados: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- Via `models.providers` (endpoints customizados): `minimax` (cloud/API), além de qualquer proxy compatível com OpenAI/Anthropic (LM Studio, vLLM, LiteLLM, etc.)

Dica: não tente codificar “todos os modelos” nos docs. A lista autoritativa é o que `discoverModels(...)` retorna na sua máquina + as chaves disponíveis.

## Credenciais (nunca commitar)

Os testes live descobrem credenciais da mesma forma que a CLI. Implicações práticas:

- Se a CLI funciona, os testes live devem encontrar as mesmas chaves.

- Se um teste live disser “sem credenciais”, depure da mesma forma que você depuraria `openclaw models list` / seleção de modelo.

- Store de perfis: `~/.openclaw/credentials/` (preferido; é o que “chaves de perfil” significa nos testes)

- Configuração: `~/.openclaw/openclaw.json` (ou `OPENCLAW_CONFIG_PATH`)

Se você quiser depender de chaves de ambiente (por exemplo, exportadas no seu `~/.profile`), execute testes locais após `source ~/.profile`, ou use os runners Docker abaixo (eles podem montar `~/.profile` no container).

## Deepgram live (transcrição de áudio)

- Teste: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- Habilitar: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Runners Docker (checks opcionais “funciona no Linux”)

Eles executam `pnpm test:live` dentro da imagem Docker do repo, montando seu diretório de configuração local e workspace (e fazendo source de `~/.profile` se montado):

- Modelos diretos: `pnpm test:docker:live-models` (script: `scripts/test-live-models-docker.sh`)
- Gateway + agente de desenvolvimento: `pnpm test:docker:live-gateway` (script: `scripts/test-live-gateway-models-docker.sh`)
- Assistente de onboarding (TTY, scaffolding completo): `pnpm test:docker:onboard` (script: `scripts/e2e/onboard-docker.sh`)
- Networking do gateway (dois containers, auth WS + health): `pnpm test:docker:gateway-network` (script: `scripts/e2e/gateway-network-docker.sh`)
- Plugins (carregamento de extensão customizada + smoke do registry): `pnpm test:docker:plugins` (script: `scripts/e2e/plugins-docker.sh`)

Env vs úteis:

- `OPENCLAW_CONFIG_DIR=...` (padrão: `~/.openclaw`) montado em `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...` (padrão: `~/.openclaw/workspace`) montado em `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...` (padrão: `~/.profile`) montado em `/home/node/.profile` e aplicado antes de rodar os testes
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` para restringir a execução
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` para garantir que as credenciais venham do store de perfis (não do ambiente)

## Sanidade dos docs

Execute checagens de docs após edições: `pnpm docs:list`.

## Regressão offline (segura para CI)

Estas são regressões de “pipeline real” sem provedores reais:

- Tool calling do gateway (OpenAI mockado, gateway + loop do agente reais): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Assistente do gateway (WS `wizard.start`/`wizard.next`, grava configuração + autenticação aplicada): `src/gateway/gateway.wizard.e2e.test.ts`

## Avaliações de confiabilidade do agente (skills)

Já temos alguns testes seguros para CI que se comportam como “avaliações de confiabilidade do agente”:

- Tool-calling mockado através do loop real do gateway + agente (`src/gateway/gateway.tool-calling.mock-openai.test.ts`).
- Fluxos end-to-end do assistente que validam o encadeamento de sessões e efeitos de configuração (`src/gateway/gateway.wizard.e2e.test.ts`).

O que ainda falta para skills (veja [Skills](/tools/skills)):

- **Decisão:** quando skills são listadas no prompt, o agente escolhe a skill certa (ou evita as irrelevantes)?
- **Conformidade:** o agente lê `SKILL.md` antes de usar e segue os passos/args exigidos?
- **Contratos de workflow:** cenários multi-turn que verificam ordem de ferramentas, carryover do histórico da sessão e limites de sandbox.

Avaliações futuras devem permanecer determinísticas primeiro:

- Um runner de cenários usando provedores mock para verificar chamadas de ferramentas + ordem, leituras de arquivos de skill e encadeamento de sessões.
- Um pequeno conjunto de cenários focados em skills (usar vs evitar, gating, prompt injection).
- Avaliações live opcionais (opt-in, controladas por env) somente depois que a suíte segura para CI estiver pronta.

## Adicionando regressões (orientação)

Quando você corrige um problema de provedor/modelo descoberto em live:

- Adicione uma regressão segura para CI se possível (mock/stub do provedor, ou capture a transformação exata do formato da requisição)
- Se for inerentemente apenas live (rate limits, políticas de auth), mantenha o teste live restrito e opt-in via variáveis de ambiente
- Prefira atingir a menor camada que captura o bug:
  - bug de conversão/replay de requisição do provedor → teste de modelos diretos
  - bug no pipeline de sessão/histórico/ferramentas do gateway → gateway live smoke ou teste mockado do gateway seguro para CI
