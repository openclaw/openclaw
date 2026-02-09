---
summary: "Use o MiniMax M2.1 no OpenClaw"
read_when:
  - Você quer modelos MiniMax no OpenClaw
  - Você precisa de orientação de configuração do MiniMax
title: "MiniMax"
---

# MiniMax

MiniMax é uma empresa de IA que desenvolve a família de modelos **M2/M2.1**. O lançamento atual com foco em programação é o **MiniMax M2.1** (23 de dezembro de 2025), criado para tarefas complexas do mundo real.

Fonte: [Nota de lançamento do MiniMax M2.1](https://www.minimax.io/news/minimax-m21)

## Visão geral do modelo (M2.1)

A MiniMax destaca estas melhorias no M2.1:

- **Programação multilíngue** mais forte (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).
- Melhor **desenvolvimento web/app** e qualidade estética das saídas (incluindo mobile nativo).
- Manuseio aprimorado de **instruções compostas** para fluxos de trabalho no estilo escritório, com base em raciocínio intercalado e execução integrada de restrições.
- **Respostas mais concisas**, com menor uso de tokens e ciclos de iteração mais rápidos.
- Compatibilidade mais forte com **frameworks de ferramentas/agentes** e gerenciamento de contexto (Claude Code, Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox).
- Saídas de **diálogo e escrita técnica** de maior qualidade.

## MiniMax M2.1 vs MiniMax M2.1 Lightning

- **Velocidade:** Lightning é a variante “rápida” nos documentos de preços da MiniMax.
- **Custo:** Os preços mostram o mesmo custo de entrada, mas o Lightning tem custo de saída mais alto.
- **Roteamento do plano de programação:** O back-end Lightning não está diretamente disponível no plano de programação da MiniMax. A MiniMax direciona automaticamente a maioria das solicitações para o Lightning, mas faz fallback para o back-end M2.1 regular durante picos de tráfego.

## Escolha uma configuração

### MiniMax OAuth (Plano de Programação) — recomendado

**Ideal para:** configuração rápida com o Plano de Programação MiniMax via OAuth, sem necessidade de chave de API.

Ative o plugin OAuth incluído e autentique:

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

Você será solicitado a selecionar um endpoint:

- **Global** - Usuários internacionais (`api.minimax.io`)
- **CN** - Usuários na China (`api.minimaxi.com`)

Veja o [README do plugin MiniMax OAuth](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) para detalhes.

### MiniMax M2.1 (chave de API)

**Ideal para:** MiniMax hospedado com API compatível com Anthropic.

Configure via CLI:

- Execute `openclaw configure`
- Selecione **Model/auth**
- Escolha **MiniMax M2.1**

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.1 como fallback (Opus primário)

**Ideal para:** manter o Opus 4.6 como primário e fazer failover para o MiniMax M2.1.

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

### Opcional: Local via LM Studio (manual)

**Ideal para:** inferência local com o LM Studio.
Vimos resultados fortes com o MiniMax M2.1 em hardware potente (por exemplo, um
desktop/servidor) usando o servidor local do LM Studio.

Configure manualmente via `openclaw.json`:

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Configurar via `openclaw configure`

Use o assistente interativo de configuração para definir o MiniMax sem editar JSON:

1. Execute `openclaw configure`.
2. Selecione **Model/auth**.
3. Escolha **MiniMax M2.1**.
4. Selecione seu modelo padrão quando solicitado.

## Opções de configuração

- `models.providers.minimax.baseUrl`: prefira `https://api.minimax.io/anthropic` (compatível com Anthropic); `https://api.minimax.io/v1` é opcional para payloads compatíveis com OpenAI.
- `models.providers.minimax.api`: prefira `anthropic-messages`; `openai-completions` é opcional para payloads compatíveis com OpenAI.
- `models.providers.minimax.apiKey`: chave de API da MiniMax (`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: defina `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`.
- `agents.defaults.models`: crie aliases dos modelos que você deseja na lista de permissões.
- `models.mode`: mantenha `merge` se você quiser adicionar o MiniMax junto aos modelos integrados.

## Notas

- As referências de modelo são `minimax/<model>`.
- API de uso do Plano de Programação: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (requer uma chave do plano de programação).
- Atualize os valores de preços em `models.json` se você precisar de rastreamento exato de custos.
- Link de indicação para o Plano de Programação MiniMax (10% de desconto): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- Veja [/concepts/model-providers](/concepts/model-providers) para regras de provedores.
- Use `openclaw models list` e `openclaw models set minimax/MiniMax-M2.1` para alternar.

## Solução de problemas

### “Unknown model: minimax/MiniMax-M2.1”

Isso geralmente significa que o **provedor MiniMax não está configurado** (nenhuma entrada de provedor
e nenhum perfil de autenticação/env key da MiniMax encontrado). Uma correção para essa detecção está em
**2026.1.12** (não lançado no momento da escrita). Corrija fazendo:

- Atualização para **2026.1.12** (ou execute a partir do código-fonte `main`), depois reinicie o gateway.
- Executando `openclaw configure` e selecionando **MiniMax M2.1**, ou
- Adicionando o bloco `models.providers.minimax` manualmente, ou
- Definindo `MINIMAX_API_KEY` (ou um perfil de autenticação da MiniMax) para que o provedor possa ser injetado.

Certifique-se de que o ID do modelo é **sensível a maiúsculas/minúsculas**:

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

Depois verifique novamente com:

```bash
openclaw models list
```
