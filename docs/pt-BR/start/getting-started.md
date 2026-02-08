---
summary: "Instale o OpenClaw e execute seu primeiro chat em minutos."
read_when:
  - Primeira configuração do zero
  - Voce quer o caminho mais rápido para um chat funcional
title: "Primeiros passos"
x-i18n:
  source_path: start/getting-started.md
  source_hash: 6eeb4d38a70f2ad9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:31:59Z
---

# Primeiros passos

Objetivo: ir do zero até o primeiro chat funcional com configuração mínima.

<Info>
Chat mais rápido: abra a Control UI (nenhuma configuração de canal necessária). Execute `openclaw dashboard`
e converse no navegador, ou abra `http://127.0.0.1:18789/` no
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">host do Gateway</Tooltip>.
Docs: [Dashboard](/web/dashboard) e [Control UI](/web/control-ui).
</Info>

## Pré-requisitos

- Node 22 ou mais recente

<Tip>
Verifique sua versão do Node com `node --version` se tiver dúvidas.
</Tip>

## Início rápido (CLI)

<Steps>
  <Step title="Instalar o OpenClaw (recomendado)">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    Outros métodos de instalação e requisitos: [Instalar](/install).
    </Note>

  </Step>
  <Step title="Executar o assistente de integração inicial">
    ```bash
    openclaw onboard --install-daemon
    ```

    O assistente configura autenticação, configurações do gateway e canais opcionais.
    Veja [Onboarding Wizard](/start/wizard) para detalhes.

  </Step>
  <Step title="Verificar o Gateway">
    Se voce instalou o serviço, ele já deve estar em execução:

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Abrir a Control UI">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
Se a Control UI carregar, seu Gateway está pronto para uso.
</Check>

## Verificações opcionais e extras

<AccordionGroup>
  <Accordion title="Executar o Gateway em primeiro plano">
    Útil para testes rápidos ou solução de problemas.

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="Enviar uma mensagem de teste">
    Requer um canal configurado.

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## Aprofunde-se

<Columns>
  <Card title="Onboarding Wizard (detalhes)" href="/start/wizard">
    Referência completa do assistente de CLI e opções avançadas.
  </Card>
  <Card title="Integração inicial do app macOS" href="/start/onboarding">
    Fluxo da primeira execução para o app macOS.
  </Card>
</Columns>

## O que voce terá

- Um Gateway em execução
- Autenticação configurada
- Acesso à Control UI ou um canal conectado

## Próximos passos

- Segurança e aprovações de DM: [Pairing](/channels/pairing)
- Conectar mais canais: [Channels](/channels)
- Fluxos avançados e a partir do código-fonte: [Configuração](/start/setup)
