---
summary: "Fluxo de integração inicial na primeira execução do OpenClaw (app macOS)"
read_when:
  - Projetando o assistente de integração do macOS
  - Implementando autenticação ou configuração de identidade
title: "Integração inicial (App macOS)"
sidebarTitle: "Onboarding: macOS App"
x-i18n:
  source_path: start/onboarding.md
  source_hash: 45f912067527158f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:32:01Z
---

# Integração inicial (App macOS)

Este documento descreve o fluxo **atual** de integração inicial na primeira execução. O objetivo é uma experiência suave no “dia 0”: escolher onde o Gateway roda, conectar a autenticação, executar o assistente e deixar o agente se inicializar sozinho.

<Steps>
<Step title="Aprovar aviso do macOS">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Aprovar descoberta de redes locais">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Boas-vindas e aviso de segurança">
<Frame caption="Leia o aviso de segurança exibido e decida conforme apropriado">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remoto">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

Onde o **Gateway** roda?

- **Este Mac (somente local):** a integração inicial pode executar fluxos OAuth e gravar credenciais localmente.
- **Remoto (via SSH/Tailnet):** a integração inicial **não** executa OAuth localmente; as credenciais devem existir no host do gateway.
- **Configurar depois:** pula a configuração e deixa o app não configurado.

<Tip>
**Dica de autenticação do Gateway:**
- O assistente agora gera um **token** mesmo para loopback, então clientes WS locais devem se autenticar.
- Se você desativar a autenticação, qualquer processo local pode se conectar; use isso apenas em máquinas totalmente confiáveis.
- Use um **token** para acesso em várias máquinas ou para binds non-loopback.
</Tip>
</Step>
<Step title="Permissões">
<Frame caption="Escolha quais permissões você deseja conceder ao OpenClaw">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

A integração inicial solicita permissões TCC necessárias para:

- Automação (AppleScript)
- Notificações
- Acessibilidade
- Gravação de Tela
- Microfone
- Reconhecimento de Fala
- Câmera
- Localização

</Step>
<Step title="CLI">
  <Info>Esta etapa é opcional</Info>
  O app pode instalar a CLI global `openclaw` via npm/pnpm para que fluxos de trabalho no terminal e tarefas do launchd funcionem imediatamente.
</Step>
<Step title="Chat de integração inicial (sessão dedicada)">
  Após a configuração, o app abre uma sessão de chat dedicada à integração inicial para que o agente possa se apresentar e orientar os próximos passos. Isso mantém a orientação da primeira execução separada da sua conversa normal. Veja [Bootstrapping](/start/bootstrapping) para entender o que acontece no host do gateway durante a primeira execução do agente.
</Step>
</Steps>
