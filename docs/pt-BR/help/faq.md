---
summary: "Perguntas frequentes sobre configuração, instalação e uso do OpenClaw"
title: "Perguntas frequentes"
---

# Perguntas frequentes

Respostas rápidas e solução de problemas mais aprofundada para cenários do mundo real (desenvolvimento local, VPS, múltiplos agentes, chaves OAuth/API, failover de modelos). Para diagnósticos em tempo de execução, veja [Solução de problemas](/gateway/troubleshooting). Para a referência completa de configuração, veja [Configuração](/gateway/configuration).

## Tabela de conteúdos

- [Início rápido e configuração da primeira execução]
  - [Estou travado: qual é a forma mais rápida de destravar?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [Qual é a forma recomendada de instalar e configurar o OpenClaw?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [Como abro o painel após a integração inicial?](#how-do-i-open-the-dashboard-after-onboarding)
  - [Como autentico o token do painel no localhost vs remoto?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [Qual runtime eu preciso?](#what-runtime-do-i-need)
  - [Ele roda em Raspberry Pi?](#does-it-run-on-raspberry-pi)
  - [Alguma dica para instalações em Raspberry Pi?](#any-tips-for-raspberry-pi-installs)
  - [Está travado em "wake up my friend" / a integração não finaliza. E agora?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [Posso migrar minha configuração para uma nova máquina (Mac mini) sem refazer a integração?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [Onde vejo o que há de novo na versão mais recente?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [Não consigo acessar docs.openclaw.ai (erro de SSL). E agora?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [Qual é a diferença entre stable e beta?](#whats-the-difference-between-stable-and-beta)
  - [Como instalo a versão beta e qual é a diferença entre beta e dev?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [Como testo os bits mais recentes?](#how-do-i-try-the-latest-bits)
  - [Quanto tempo a instalação e a integração inicial costumam levar?](#how-long-does-install-and-onboarding-usually-take)
  - [Instalador travado? Como obtenho mais feedback?](#installer-stuck-how-do-i-get-more-feedback)
  - [A instalação no Windows diz git não encontrado ou openclaw não reconhecido](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [A documentação não respondeu minha pergunta — como obtenho uma resposta melhor?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [Como instalo o OpenClaw no Linux?](#how-do-i-install-openclaw-on-linux)
  - [Como instalo o OpenClaw em um VPS?](#how-do-i-install-openclaw-on-a-vps)
  - [Onde estão os guias de instalação em nuvem/VPS?](#where-are-the-cloudvps-install-guides)
  - [Posso pedir para o OpenClaw se atualizar sozinho?](#can-i-ask-openclaw-to-update-itself)
  - [O que o assistente de integração realmente faz?](#what-does-the-onboarding-wizard-actually-do)
  - [Preciso de uma assinatura do Claude ou OpenAI para rodar isso?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [Posso usar a assinatura Claude Max sem uma chave de API?](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Como funciona a autenticação setup-token da Anthropic?](#how-does-anthropic-setuptoken-auth-work)
  - [Onde encontro um setup-token da Anthropic?](#where-do-i-find-an-anthropic-setuptoken)
  - [Vocês suportam autenticação por assinatura do Claude (Claude Pro ou Max)?](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Por que estou vendo `HTTP 429: rate_limit_error` da Anthropic?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [AWS Bedrock é suportado?](#is-aws-bedrock-supported)
  - [Como funciona a autenticação do Codex?](#how-does-codex-auth-work)
  - [Vocês suportam autenticação por assinatura OpenAI (Codex OAuth)?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [Como configuro o OAuth da Gemini CLI](#how-do-i-set-up-gemini-cli-oauth)
  - [Um modelo local serve para conversas casuais?](#is-a-local-model-ok-for-casual-chats)
  - [Como mantenho o tráfego de modelos hospedados em uma região específica?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [Preciso comprar um Mac Mini para instalar isso?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [Preciso de um Mac mini para suporte ao iMessage?](#do-i-need-a-mac-mini-for-imessage-support)
  - [Se eu comprar um Mac mini para rodar o OpenClaw, posso conectá-lo ao meu MacBook Pro?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Posso usar Bun?](#can-i-use-bun)
  - [Telegram: o que vai em `allowFrom`?](#telegram-what-goes-in-allowfrom)
  - [Várias pessoas podem usar um número de WhatsApp com diferentes instâncias do OpenClaw?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [Posso rodar um agente de “chat rápido” e um agente “Opus para código”?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [O Homebrew funciona no Linux?](#does-homebrew-work-on-linux)
  - [Qual é a diferença entre a instalação hackeável (git) e a instalação via npm?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [Posso alternar entre instalações npm e git depois?](#can-i-switch-between-npm-and-git-installs-later)
  - [Devo rodar o Gateway no meu laptop ou em um VPS?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [Quão importante é rodar o OpenClaw em uma máquina dedicada?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [Quais são os requisitos mínimos de um VPS e o SO recomendado?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [Posso rodar o OpenClaw em uma VM e quais são os requisitos](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [O que é OpenClaw?](#what-is-openclaw)
  - [O que é o OpenClaw, em um parágrafo?](#what-is-openclaw-in-one-paragraph)
  - [Qual é a proposta de valor?](#whats-the-value-proposition)
  - [Acabei de definir o que devo fazer primeiro](#i-just-set-it-up-what-should-i-do-first)
  - [Quais são os cinco melhores casos de uso diário para OpenClaw](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [Pode o OpenClaw ajudar com anúncios e blogs sobre o potencial geracional em um SaaS](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [Quais são as vantagens vs Claude Code para o desenvolvimento da web?](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Habilidades e automação](#skills-and-automation)
  - [Como personalizar as habilidades sem deixar o repositório sujo?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [Posso carregar habilidades de uma pasta personalizada?](#can-i-load-skills-from-a-custom-folder)
  - [Como posso usar modelos diferentes para tarefas diferentes?](#how-can-i-use-different-models-for-different-tasks)
  - [O bot congela enquanto faz um trabalho pesado. Como faço para descarregar isso?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [CRON ou lembretes não disparam. O que devo verificar?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [Como instalar habilidades no Linux?](#how-do-i-install-skills-on-linux)
  - [O OpenClaw pode executar tarefas em um horário ou continuamente em segundo plano?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [Posso executar habilidades só para macOS da Apple no Linux?](#can-i-run-apple-macos-only-skills-from-linux)
  - [Você tem alguma integração com o HeyGen?](#do-you-have-a-notion-or-heygen-integration)
  - [Como instalar a extensão Chrome para aquisição do navegador?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [Arenito e memória](#sandboxing-and-memory)
  - [Existe algum sandboxing doc?](#is-there-a-dedicated-sandboxing-doc)
  - [Como vincular uma pasta de host na sandbox?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [Como funciona a memória?](#how-does-memory-work)
  - [A memória continua esquecendo as coisas. Como faço para ficar?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [A memória persiste para sempre? Quais são os limites?](#does-memory-persist-forever-what-are-the-limits)
  - [A pesquisa semântica de memória requer uma chave de API OpenAI?](#does-semantic-memory-search-require-an-openai-api-key)
- [Onde as coisas moram em disco](#where-things-live-on-disk)
  - [Todos os dados usados no OpenClaw são salvos localmente?](#is-all-data-used-with-openclaw-saved-locally)
  - [Onde o OpenClaw armazena seus dados?](#where-does-openclaw-store-its-data)
  - [Onde deve o AGENTS.md / SOUL.md / USER.md / MEMORY.md live?](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [Qual é a estratégia de backup recomendada?](#whats-the-recommended-backup-strategy)
  - [Como desinstalar completamente o OpenClaw?](#how-do-i-completely-uninstall-openclaw)
  - [Agentes podem trabalhar fora do espaço de trabalho?](#can-agents-work-outside-the-workspace)
  - [Estou em modo remoto - onde está a sessão loja?](#im-in-remote-mode-where-is-the-session-store)
- [Básico de configuração](#config-basics)
  - [Qual é o formato da configuração? Onde está?](#what-format-is-the-config-where-is-it)
  - [Eu defino `gateway.bind: "lan"` (ou `"tailnet"`) e agora nada ouve / interface do usuário diz não autorizado](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [Por que preciso de um token localizado agora?](#why-do-i-need-a-token-on-localhost-now)
  - [Preciso reiniciar após alterar a configuração?](#do-i-have-to-restart-after-changing-config)
  - [Como ativar a pesquisa na web (e pesquisa na web)?](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply limpou minha configuração. Como faço para recuperar e evitar isso?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [Como executo um Gateway central com trabalhadores especializados em dispositivos?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [O navegador OpenClaw pode correr sem cabeça?](#can-the-openclaw-browser-run-headless)
  - [Como usar o Brave para o controle do navegador?](#how-do-i-use-brave-for-browser-control)
- [gateways e nós remotos](#remote-gateways-and-nodes)
  - [Como os comandos se propagam entre o Telegram, o gateway e os nós?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [Como meu agente pode acessar o meu computador se o Gateway está hospedado remotamente?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [A Escala Caudal está conectada, mas não tenho respostas. E agora?](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [É possível conversar entre si duas instâncias OpenClaw (local + VPS)?](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [Preciso de VPSes separados para vários agentes](#do-i-need-separate-vpses-for-multiple-agents)
  - [Há vantagem em usar um nó no meu laptop pessoal em vez de SSH por meio de um VPS?](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [Os nós executam um serviço de gateway?](#do-nodes-run-a-gateway-service)
  - [Existe uma forma de API / RPC para aplicar a configuração?](#is-there-an-api-rpc-way-to-apply-config)
  - [Qual é a configuração mínima "saneamento" para uma primeira instalação?](#whats-a-minimal-sane-config-for-a-first-install)
  - [Como configurar escala alfaiate em um VPS e me conectar do meu Mac?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [Como conectar um nó Mac a um Gateway remoto (Serviço de escala selvagem)?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [Devo instalar em um segundo laptop ou apenas adicionar um nó?](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [Env vars e .env loading](#env-vars-and-env-loading)
  - [Como OpenClaw carregar variáveis de ambiente?](#how-does-openclaw-load-environment-variables)
  - ["Eu comecei o Gateway pelo serviço e meus vars de env desapareceram." E agora?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [Eu defino `COPILOT_GITHUB_TOKEN`, mas o status dos modelos mostra "Shell env: off." Porque?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [Sessões e múltiplos chats](#sessions-and-multiple-chats)
  - [Como começar uma conversa nova?](#how-do-i-start-a-fresh-conversation)
  - [Reinicia as sessões automaticamente se nunca enviar `/new`?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [Existe uma maneira de fazer uma equipe de OpenClaw instâncias um CEO e muitos agentes](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [Por que o contexto foi truncado na tarefa média? Como posso evitá-lo?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [Como resetar completamente o OpenClaw mas mantê-lo instalado?](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [Estou recebendo erros de "contexto grande demais" - como redefino ou compacto?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [Por que estou vendo "solicitação LM rejeitada: mensagens.N.content.X.tool_use.input: Campo requerido"?](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [Por que recebo mensagens de pulso a cada 30 minutos?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [Preciso adicionar uma "conta bot" em um grupo de WhatsApp?](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [Como consigo a JID de um grupo de WhatsApp?](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [Por que a OpenClaw não responde em um grupo?](#why-doesnt-openclaw-reply-in-a-group)
  - [Grupos e tópicos compartilham o contexto com DMs?](#do-groupsthreads-share-context-with-dms)
  - [Quantos espaços de trabalho e agentes posso criar?](#how-many-workspaces-and-agents-can-i-create)
  - [Posso executar vários bots ou chats ao mesmo tempo (Slack) e como devo configurar isso?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [Modelos: padrões, seleção, alias, comutação](#models-defaults-selection-aliases-switching)
  - [O que é o "modelo padrão"?](#what-is-the-default-model)
  - [Que modelo você recomenda?](#what-model-do-you-recommend)
  - [Como alternar modelos sem apagar a minha configuração?](#how-do-i-switch-models-without-wiping-my-config)
  - [Posso usar modelos auto-hospedados (llama.cpp, vLLM, Ollama)?](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [O que usam OpenClaw, Flawd e Krill para modelos?](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [Como faço para alternar os modelos na mosca (sem reiniciar)?](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [Posso usar o GPT 5.2 para tarefas diárias e o Codex 5.3 para codificação](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [Por que eu vejo "Modelo … não é permitido" e depois não há resposta?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [Por que eu vejo "Modelo desconhecido: minimax/MiniMax-M2.1"?](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [Posso usar o MiniMax como meu padrão e o OpenAI para tarefas complexas?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [O opus / sonnet / gpt integra-se nos atalhos?](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [Como definir/substituir atalhos do modelo (alias)?](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [Como adicionar modelos de outros provedores como OpenRouter ou Z.AI?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [Model failover e "Todos os modelos falharam"](#model-failover-and-all-models-failed)
  - [Como a falha funciona?](#how-does-failover-work)
  - [O que este erro significa?](#what-does-this-error-mean)
  - [Corrigir checklist para `Não foram encontradas credenciais para o perfil "anthropic:default"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [Por que também experimentou o Google Gemini e falhou?](#why-did-it-also-try-google-gemini-and-fail)
- [Perfis de autenticação: o que são e como gerenciá-los](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [Qual é um perfil de autenticação?](#what-is-an-auth-profile)
  - [Quais são as identificações típicas?](#what-are-typical-profile-ids)
  - [Posso controlar qual perfil de autenticação está tentando primeiro?](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth vs chave da API: qual é a diferença?](#oauth-vs-api-key-whats-the-difference)
- [Gateway: portas, "já em execução" e modo remoto](#gateway-ports-already-running-and-remote-mode)
  - [Qual porta usa o Gatewa?](#what-port-does-the-gateway-use)
  - [Por que `openclaw gateway status` diz `Runtime: running` mas `RPC probe: falhou`?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [Por que o status do gateway openclaw mostra `Config (cli)` e `Config (serviço)` diferente?](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - [O que significa "outra instância do gateway já está escutando"?](#what-does-another-gateway-instance-is-already-listening-mean)
  - [Como executar o OpenClaw no modo remoto (cliente conecta a um Gateway em outro lugar)?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [A interface do controle diz "não autorizado" (ou continua reconectando). E agora?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [Eu defini `gateway.bind: "tailnet"` mas não consigo vincular / nenhuma lista](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [Posso executar vários Gateways no mesmo host?](#can-i-run-multiple-gateways-on-the-same-host)
  - [O que significa "handshake inválido"? / código 1008 significa?](#what-does-invalid-handshake-code-1008-mean)
- [Registro e depuração](#logging-and-debugging)
  - [Onde estão os registros?](#where-are-logs)
  - [Como começar/parar/reiniciar o serviço do Gatewa?](#how-do-i-startstoprestart-the-gateway-service)
  - [Eu fechei meu terminal no Windows - como reiniciar o OpenClaw?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [O Gateway está pronto, mas as respostas nunca chegaram. O que devo verificar?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - ["Desconectado do gateway: sem motivo" - e agora?](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands falhou com erros de rede. O que devo verificar?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI não mostra nenhuma saída. O que devo verificar?](#tui-shows-no-output-what-should-i-check)
  - [Como parar completamente e começar o Gateway?](#how-do-i-completely-stop-then-start-the-gateway)
  - [ELI5: `openclaw gateway restart` vs `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [Qual é a maneira mais rápida de obter mais detalhes quando algo falhar?](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [Mídia e Anexos](#media-and-attachments)
  - [Minha habilidade gerou uma imagem/PDF, mas nada foi enviado](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [Segurança e controle de acesso](#security-and-access-control)
  - [É seguro expor OpenClaw a mensagens de entrada de dados?](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [O prompt injection é apenas uma preocupação com bots públicos?](#is-prompt-injection-only-a-concern-for-public-bots)
  - [Meu bot deve ter sua própria conta no GitHub ou número de telefone](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [Posso dar-lhe autonomia sobre as minhas mensagens de texto e é aquela segura](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [Posso usar modelos mais baratos para tarefas pessoais de assistente?](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [Eu executei `/start` no Telegram, mas não consegui um código de emparelhamento](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp: uma mensagem para meus contatos? Como funciona o emparelhamento?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [Comandos de bate-papo, tarefas canceladas e "não vai parar"](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [Como impedir que mensagens do sistema interno sejam exibidas no chat](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [Como parar/cancelar uma tarefa em execução?](#how-do-i-stopcancel-a-running-task)
  - [Como enviar uma mensagem do Discord do Telegram? ("Mensagens cruzadas negadas")](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [Por que se sente como o bot "ignora" mensagens rápidas de fogo?](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## Primeiros 60 segundos se algo estiver quebrado

1. **Estado rápido (primeira verificação)**

   ```bash
   openclaw status
   ```

   Resumo local: OS + atualização, acesso ao gateway/serviço, agentes/sessões, configuração do provedor + problemas de tempo de execução (quando o gateway é acessível).

2. **Relatório Pasteable (seguro para compartilhar)**

   ```bash
   status openclaw --all
   ```

   Diagrama somente leitura com cauda de log (tokens redacted).

3. **Daemon + estado da porta**

   ```bash
   openclaw gateway status
   ```

   Mostra supervisor tempo de execução vs RPC reachability, a URL de destino de sondagem, e qual configuração o serviço provavelmente usado.

4. **Provas profundas**

   ```bash
   status openclaw --deep
   ```

   Executa verificações de saúde do gateway + experiências de provedor (requer um gateway acessível). Ver [Health](/gateway/health).

5. **Cauda o último tronco**

   ```bash
   openclaw logs --follow
   ```

   Se o RPC estiver no chão, volte para:

   ```bash
   cauda -f "$(ls -t /tmp/openclaw/openclaw-*.log ├head -1)"
   ```

   Os logs dos arquivos são separados dos logs de serviço; ver [Logging](/logging) e [Troubleshooting](/gateway/troubleshooting).

6. **Execute o médico (reparos)**

   ```bash
   openclaw doctor
   ```

   Reparações/migrates config/state + executa verificações de saúde. Ver [Doctor](/gateway/doctor).

7. **Gateway snapshot**

   ```bash
   openclaw saúde --json
   openclaw saúde --verbose # mostra a URL de destino + caminho de configuração de erros
   ```

   Solicita o gateway executando para um snapshot completo (Somente WS). Ver [Health](/gateway/health).

## Início rápido e configuração da primeira execução

### Estou preso é o caminho mais rápido para se desprender

Use um agente de IA local que pode **ver a sua máquina**. Isso é muito mais eficaz do que perguntar
no Discord, porque a maioria dos casos "Estou preso" são **configurações locais ou problemas de ambiente** que
ajudantes remotos não podem inspecionar.

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **Código OpenAI**: [https://openai.com/codex/](https://openai.com/codex/)

Essas ferramentas podem ler o repositório, executar comandos, inspecionar logs e ajudar a corrigir sua configuração de nível
de máquina (PATH, serviços, permissões, arquivos de autenticação). Dê a eles o **check-out completo** via
a instalação de hackeável (git):

```bash
curl -fsSL https://openclaw.ai/install.sh £bash -s -- ----install-method git
```

Isto instala o OpenClaw **a partir de um checkout**, para que o agente possa ler o código + docs e
sobre a versão exata que você está executando. Você sempre pode voltar ao estável
reexecutando o instalador sem `--install-method git`.

Dica: peça ao agente para **planejar e supervisionar** a correção (passo a passo), em seguida, execute apenas os comandos
necessários. Isso continua a ser pequeno e mais fácil de auditar.

Se você descobrir um bug real ou corrigir, por favor, envie uma issue no GitHub ou envie um PR:
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

Comece com esses comandos (compartilhe saídas quando pedir ajuda):

```bash
status openclaw
openclaw status de modelo
médico openclaw
```

O que fazem:

- `openclaw status`: snapshot rápido do gateway/saúde do agente + configuração básica.
- `openclaw models status`: verifica autenticação do provedor + disponibilidade do modelo.
- `médico openclaw`: valida e conserta problemas comuns de configuração/estado.

Outros verificações de CLI úteis: `openclaw status --all`, `openclaw logs --follow`,
`openclaw gateway status`, `openclaw health --verbose`.

loop de depuração rápido: [First 60 segundos se algo estiver quebrado](#first-60-seconds-if-somethings-broken).
Instalar documentos: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating).

### Qual é a maneira recomendada de instalar e configurar o OpenClaw

O repositório recomenda que você rode a partir da fonte e usando o assistente de integração:

```bash
curl -fsSL https://openclaw.ai/install.sh £bash
openclaw a bordo --install-daemon
```

O assistente também pode construir automaticamente os ativos de UI. Após a integração, você normalmente executa o Gateway na porta **18789**.

Da fonte (contribuidores/dev):

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # auto-instalações da UI depende da primeira execução
openclaw a board
```

Se você ainda não tem uma instalação global, execute-a via `pnpm openclaw onboard`.

### Como abrir o painel após a integração

O assistente abre seu navegador com uma URL de painel de controle limpo (não tokenizado) logo após a integração e também imprime o link no resumo. Mantenha essa aba aberta; se ela não iniciar, copie/cole o URL impresso na mesma máquina.

### Como autenticar o token do painel de controle no controle local vs controle remoto

**Localhost (mesma máquina):**

- Abra `http://127.0.0.1:18789/`.
- Se ele pedir por autenticação, cole o token do `gateway.auth.token` (ou do `OPENCLAW_GATEWAY_TOKEN`) nas configurações de UI do controle.
- Recupere do host de gateway: `openclaw config get gateway.auth.token` (ou gere um: `openclaw doctor --generate-gateway-token`).

**Não está no localhost:**

- **Serviço de escala** (recomendado): mantenha o loopback, execute `openclaw gateway --tailscale serve`, abra `https://<magicdns>/`. Se o `gateway.auth.allowTailscale` é `true`, os cabeçalhos de identidade satisfazem a autenticação (sem token).
- **binding Tailnet**: rode o `openclaw gateway --bind tailnet --token "<token>"`, abra `http://<tailscale-ip>:18789/`, cole o token nas configurações do painel.
- **Túnel SSH**: `ssh -N -L 18789:127.0.0.1:18789 user@host` e então abra o `http://127.0.0.1:18789/` e cole o token nas configurações da UI de controle.

Veja [Dashboard](/web/dashboard) e [Web surfaces](/web) para vincular modos e detalhes de autenticação.

### Que tempo de execução preciso

O nó **>= 22** é obrigatório. O `pnpm` é recomendado. Bun não é **recomendado** para o Gateway.

### É executado no Raspberry Pi

Sim. O Gateway é leve - lista de documentos **512MB-1GB RAM**, **1 core**, e sobre **500MB**
disco suficiente para uso pessoal e note que um **Raspberry Pi 4 pode executá-lo**.

Se você quiser uma sala de ouvido extra (logs, mídia, outros serviços), **2GB é recomendado**, mas ela é
não é um mínimo difícil.

Dica: um pequeno Pi/VPS pode hospedar o Gateway, e você pode parear **nós** no seu laptop/telefone para
local tela/câmera/canvas ou execução de comando. Ver [Nodes](/nodes).

### Todas as dicas para instalações do Raspberry Pi

Versão curta: funciona, mas espera arestas aproximadas.

- Use um sistema operacional **64-bit** e mantenha o Node >= 22.
- Prefira a **instalação de hackeáveis (git)** para que você veja os registros e atualize rápido.
- Comece sem canais/habilidades, então adicione-os um por um.
- Se você atinge problemas binários estranhos, geralmente é um problema de **compatibilidade ARM**.

Documentos: [Linux](/platforms/linux), [Install](/install).

### Está preso a acordar a integração do meu amigo não chocará o que agora

Essa tela depende de o Gateway ser acessível e autenticado. A TUI também envia
"Acorde, meu amigo!" automaticamente na primeira escotilha. Se você ver essa linha com **nenhuma resposta**
e tokens ficam em 0, o agente nunca correu.

1. Reinicie o Gateway:

```bash
openclaw gateway restart
```

2. Verificar status + autenticação:

```bash
openclaw status
openclaw status
registros openclaw --follow
```

3. Se ainda estiver pendurado, execute:

```bash
openclaw doctor
```

Se o Gateway é remoto, certifique-se que a conexão túnel/Escala de Caudal esteja ativa e que a interface do usuário
esteja apontada para o Gateway correto. Veja [Remote access](/gateway/remote).

### Posso migrar minha instalação para um novo mini do computador Mac sem refazer a integração

Sim. Copie o **diretório do estado** e o **espaço de trabalho**, então execute o Doutor uma vez. This
keeps your bot "exactly the same" (memory, session history, auth, and channel
state) as long as you copy **both** locations:

1. Instale o OpenClaw na nova máquina.
2. Copie `$OPENCLAW_STATE_DIR` (padrão: `~/.openclaw`) da máquina antiga.
3. Copie seu espaço de trabalho (padrão: `~/.openclaw/workspace`).
4. Execute `openclaw doctor` e reinicie o serviço do Gateway.

Isso preserva configurações, perfis de autenticação, equipes do WhatsApp, sessões e memória. If you're in
remote mode, remember the gateway host owns the session store and workspace.

**Importante:** se você apenas commit/push seu espaço de trabalho para o GitHub, você está fazendo o backup
de **memory + bootstrap**, mas **não** histórico de sessões ou autenticação. Aqueles vivem
sob `~/.openclaw/` (por exemplo `~/.openclaw/agents/<agentId>/sessions/`).

Relacionado: [Migrating](/install/migrating), [Onde as coisas vivem no disco](/help/faq#where-does-openclaw-store-its-data),
[Espaço de trabalho do agente](/concepts/agent-workspace, [Doctor](/gateway/doctor),
[Modo remoto](/gateway/remote).

### Onde eu vejo o que há de novo na última versão

Verifique o GitHub changelog:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

As entradas mais recentes estão no topo. Se a seção superior estiver marcada **Não lançada**, a próxima seção
atualizada é a última versão enviada. As entradas são agrupadas por **Destacos**, **Alterações** e
**Corrigir** (mais docs/outras seções quando necessário).

### Não posso acessar docs.openclaw.ai erro SSL O que agora

Algumas conexões de Comcast/Xfinity bloqueiam incorretamente `docs.openclaw.ai` via Xfinity
Segurança Avançada. Desative ou permita a lista de `docs.openclaw.ai`, então tente novamente. Mais detalhes
: [Troubleshooting](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity).
Por favor, ajude-nos a desbloqueá-lo reportando aqui: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

Se você ainda não conseguir acessar o site, a documentação será espelhada no GitHub:
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### Qual é a diferença entre estável e beta

**Estável** e **beta** são **npm dist-tags**, e não linhas de código separadas:

- `último` = estável
- `beta` = versão inicial para teste

Naviamos compilações para **beta**, teste-as, e uma vez que uma compilação é sólida, nós **promovemos
essa mesma versão para `latest`**. That's why beta and stable can point at the
**same version**.

Veja o que mudou:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### Como faço para instalar a versão beta e qual a diferença entre beta e dev

**Beta** é o npm dist-tag `beta` (pode corresponder com `latest`).
**Dev** é a cabeça de movimento do `main` (git); quando publicado, ele usa o npm dist-tag `dev`.

One-liners (macOS/Linux):

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh ├bash -s -- ----beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh ├bash -s -- ----install-method git
```

Instalador do Windows (PowerShell):
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

Mais detalhes: [channels de desenvolvimento](/install/development-channels) e [bandeiras do instalador](/install/installer).

### Quanto tempo leva para instalar e integrar

Guia áspero:

- **Instalar:** 2-5 minutos
- **Integração:** 5-15 minutos dependendo de quantos canais/modelos você configurar

Se estiver desligado, utilize [Installer stuck](/help/faq#installer-stuck-how-do-i-get-more-feedback)
e o loop de depuração rápido em [Im stuck](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck).

### Como tento os últimos bits

Duas opções:

1. **Canal de desenvolvimento (check-out do git):**

```bash
atualização openclaw --canal dev
```

Isso muda para o branch `main` e atualiza da fonte.

2. **Instalação Hackable (do site do instalador):**

```bash
curl -fsSL https://openclaw.ai/install.sh £bash -s -- ----install-method git
```

Isso dá a você um repositório local que você pode editar, e então atualiza-lo via git.

Se você prefere um clone limpo manualmente, use:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

Documentos: [Update](/cli/update), [canais de desenvolvimento](/install/development-channels),
[Install](/install).

### Installer travado como eu recebo mais feedback

Execute o instalador novamente com **saída verbose**:

```bash
curl -fsSL https://openclaw.ai/install.sh £bash -s -- ----verbose
```

Instalação Beta com verbose:

```bash
curl -fsSL https://openclaw.ai/install.sh ├bash -s -- --beta --verbose
```

Para uma instalação hackeável (git):

```bash
curl -fsSL https://openclaw.ai/install.sh £bash -s -- ----install-method git --verbose
```

Mais opções: [Installer flags](/install/installer).

### A instalação do Windows diz que o git não foi encontrado ou openclaw não foi reconhecido

Dois problemas comuns no Windows:

**1) erro no npm spawnar git / git não encontrado**

- Instale o **Git para Windows** e certifique-se de que o `git` está no seu PATH.
- Feche e reabra o PowerShell, e então execute o instalador novamente.

**2) garra aberta não é reconhecida após a instalação**

- Seu diretório bin global do npm não está no PATH.

- Verificar o caminho:

  ```powershell
  npm config get prefix
  ```

- Certifique-se de `<prefix>\\bin` está no PATH (na maioria dos sistemas é `%AppData%\\npm`).

- Fechar e reabrir o PowerShell após atualizar o PATH.

Se você quer a configuração do Windows mais suave, use **WSL2** em vez do Windows nativo.
Documentos: [Windows](/platforms/windows).

### Os documentos não responderam à minha pergunta como eu recebo uma melhor resposta

Use a **instalação hackeável (git)** para que você tenha a fonte completa e a documentação localmente, então pergunte a
o seu bot (ou Claude/Codex) _a partir daquela pasta _ para que ele possa ler o repositório e responder com precisão.

```bash
curl -fsSL https://openclaw.ai/install.sh £bash -s -- ----install-method git
```

Mais detalhes: [Install](/install) e [Installer flags](/install/installer).

### Como faço para instalar o OpenClaw no Linux

Resposta curta: siga o guia Linux e então execute o assistente de integração.

- Caminho rápido do Linux + instalação do serviço: [Linux](/platforms/linux).
- Passeio completo: [Primeiros passos](/start/getting-started).
- Instalador + atualizações: [Instalar e atualizações](/install/updating).

### Como faço para instalar o OpenClaw em um VPS

Qualquer VPS Linux funciona. Instale no servidor, use SSH/Tailscale para alcançar Gateway.

Guias: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
Acesso remoto: [Gateway remote](/gateway/remote).

### Onde estão os guias de instalação na cloudVPS

Mantemos um **centro de hospedagem** com os provedores comuns. Escolha um e siga o guia:

- [Alojamento de VPS](/vps) (todos os provedores num só lugar)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

Como funciona na nuvem: o **Gateway é executado no servidor**, e você acessa
do seu laptop/telefone através da UI de Controle (ou Adaptador/SSH). Seu estado + espaço de trabalho
vive no servidor, então trate o host como a fonte da verdade e faça o backup.

Você pode emparelhar **nós** (Mac/iOS/Android/headless) para esse Gateway na nuvem para acessar
tela/câmera/tela local ou executar comandos em seu laptop enquanto mantém o Gateway
na nuvem.

Hub: [Platforms](/platforms). Acesso remoto: [Gateway remote](/gateway/remote).
Nodes: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Posso pedir ao OpenClaw para se atualizar

Resposta curta: **possível, não recomendado**. O fluxo de atualização pode reiniciar o
Gateway (que solta a sessão ativa), pode precisar de um check-out de um git limpo e
pode pedir confirmação. Safer: execute atualizações de um shell como operador.

Use o CLI:

```bash
openclaw atualiza o status
openclaw e atualiza
openclaw --channel stable^\\betav
openclaw update --tag <dist-tag|version>
openclaw atualização --no-restart
```

Se você deve automatizar de um agente:

```bash
openclaw update --yes --no-restart
o gateway openclaw reinicia
```

Documentos: [Update](/cli/update), [Updating](/install/updating).

### O que o assistente de integração faz realmente

`openclaw onboard` é o caminho de configuração recomendado. No **modo local** você caminha através de:

- **Configuração de modelo/auth modelo** (Opcionado Antrópico **setup-token** recomendado para Claude subscriptions, as chaves API do OpenAI Codex OAuth suportadas, modelos locais do LM Studio opcionais)
- Localização **Workspace** + arquivos de inicialização
- **Configurações de Gateway** (vinculado/porta/escala/cauda)
- **Provedores** (WhatsApp, Telegram, Discord, Mattermost (plugin), Signal, iMessage)
- **Instalação de Daemon** (LaunchAgent no macOS; unidade de usuário do sistema no Linux/WSL2)
- Seleção de **Verificações de saúde** e **habilidades**

Ele também avisa se seu modelo configurado é desconhecido ou ausente de autenticação.

### Preciso de uma assinatura do Claude ou do OpenAI para executar isso

Não. Você pode executar OpenClaw com **chaves de API** (Anthropic/OpenAI/others) ou com
**modelos somente locais** para que seus dados permaneçam no seu dispositivo. Assinaturas (Claude
Pro/Max ou OpenAI Codex) são formas opcionais de autenticar esses provedores.

Documentos: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[Modelos locais](/gateway/local-models), [Models](/concepts/models).

### Posso usar o Claude Max assinatura sem uma chave de API

Sim. Você pode autenticar com um **setup-token**
ao invés de uma chave de API. Este é o caminho de assinatura.

Claude Pro/Max assinaturas **não incluem uma chave de API**, então esta é a abordagem
correta para as contas de assinatura. Importante: você deve verificar com
Antrópico que este uso é permitido em sua política de assinatura e termos.
Se você quiser o caminho mais explícito e suportado, use uma chave de API Antrópica.

### Como funciona a autentificação do token Anthropic

`claude setup-token` gera uma **string de token** através do Claude Code CLI (isso não está disponível no console web). Você pode executá-lo em **qualquer máquina**. Escolha **Anthropic token (colar configuração-token)** no assistente ou cole-o com `openclaw models auth paste-token --provider anthropic`. O token é armazenado como um perfil de autenticação para o provedor **anthropic** e usado como uma chave de API (sem atualização automática). Mais detalhes: [OAuth](/concepts/oauth).

### Onde eu encontro um token de configuração antrópica

Ele **não** está no Console Antrópico. O token de configuração é gerado pelo **Claude Code CLI** em **qualquer máquina**:

```bash
claude setup-token
```

Copie o token que ele imprime, então escolha **Antrópico token (cole configuração-token)** no assistente. Se você quer executá-lo no host de gateway, use `openclaw models auth setup-token --provider anthropic`. Se você executou `claude setup-token` em outro lugar, cole-o no host de gateway com `openclaw models auth paste-token --provider anthropic`. Ver [Anthropic](/providers/anthropic).

### Você apoia sua assinatura por Claude (Claude Pro ou Max)

Sim - via **setup-token**. O OpenClaw não reusa os tokens Claude Code CLI OAuth; use um token de configuração ou uma chave de API Antrópica. Gere o token em qualquer lugar e cole-o no host de gateway. Ver [Anthropic](/providers/anthropic) e [OAuth](/concepts/oauth).

Nota: o acesso à assinatura por Claude é regido pelos termos de Anthropic. Para cargas de trabalho produtivas ou multi-usuário, chaves de API são geralmente a escolha mais segura.

### Por que estou vendo HTTP 429 ratelimiterror de Anthropic

Isso significa que seu **Limite de quota/taxa antrópica** está exausta para a janela atual. If you
use a **Claude subscription** (setup-token or Claude Code OAuth), wait for the window to
reset or upgrade your plan. Se você usar uma **Chave de API Antrópica**, verifique o Console Antrópico
para uso/faturamento e aumente os limites conforme necessário.

Dica: defina um **modelo de fallback** para que o OpenClaw possa continuar respondendo enquanto um provedor estiver com taxa limitada.
Ver [Models](/cli/models) e [OAuth](/concepts/oauth).

### A Rocha AWS é suportada

Sim - por meio do provedor **Amazon Bedrock (Conversa)** de pi-ai com a **configuração manual**. Você deve fornecer credenciais AWS região no host de gateway e adicionar uma entrada de provedor Bedrock em sua configuração de modelos. Ver [Amazon Bedrock](/providers/bedrock) e [Provedores de modelo](/providers/models). Se você prefere um fluxo de chaves gerenciadas, um proxy compatível com OpenAI-na na frente do Bedrock ainda é uma opção válida.

### Como funciona o Codex auth

O OpenClaw suporta **OpenAI Code (Codex)** via OAuth (login do ChatGPT). O assistente pode executar o fluxo OAuth e irá definir o modelo padrão como `openai-codex/gpt-5.3-codex` quando apropriado. Ver [Provedores de Modelo](/concepts/model-providers) e [Wizard](/start/wizard).

### Você suporta a assinatura OpenAI do Codex OAuth

Sim. OpenClaw suporta totalmente a assinatura OAuth\*\* do **OpenAI Code (Codex)**. O assistente de integração
pode executar o fluxo OAuth para você.

Ver [OAuth](/concepts/oauth), [Provedores do modelo](/concepts/model-providers) e [Wizard](/start/wizard).

### Como configurar o Gemini CLI OAuth

O Gemini CLI usa um **fluxo de autenticação do plugin**, não um ID de cliente ou segredo no `openclaw.json`.

Etapas:

1. Habilita o plugin: `openclaw plugins permitem google-gemini-cli-auth`
2. Login: `openclaw models auth login --provider google-gemini-cli --set-default`

Esta loja os tokens OAuth em perfis de autentificação no host de gateway. Detalhes: [Model providers](/concepts/model-providers).

### É um modelo local OK para bate-papos casuais

Geralmente não. OpenClaw precisa de um contexto grande + segurança forte; cartões pequenos truncados e vazados. Se você precisa, execute a compilação em MiniMax M2.1 que você pode localmente (LM Studio) e veja [/gateway/local-models](/gateway/local-models). Modelos Smaller/quantizados aumentam o risco de prompt-injection - ver [Security](/gateway/security).

### Como mantenho o tráfego modelo hospedado em uma região específica

Escolha endpoints fixados na região. O OpenRouter expõe opções hospedadas pelos EUA para MiniMax, Kimi e GLM; escolha a variante hospedada pelos EUA para manter os dados na região. Você ainda pode listar Anthropic/OpenAI ao lado deles usando `models.mode: "merge"` para que os fallbacks fiquem disponíveis respeitando o provedor regional que você selecionar.

### Tenho que comprar um Mac Mini para instalar isto

Não. O OpenClaw é executado no macOS ou Linux (Windows via WSL2). Um Mac mini é opcional - algumas pessoas
compram um como host sempre, mas um pequeno VPS, servidor home ou caixa Raspberry Pi-class também funciona.

Você só precisa de um Mac **para ferramentas somente para macOS**. Para iMessage, use [BlueBubbles](/channels/bluebubbles) (recomendado) - o servidor BlueBubbles é executado em qualquer Mac, e o Gateway pode ser executado no Linux ou em outro lugar. Se você quiser outras ferramentas somente para macOS, execute o Gateway em um Mac ou emparelhe um nó para macOS.

Documentos: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes), [Modo remoto Mac] (/platforms/mac/remote).

### Preciso de um Mac mini para suporte iMessage

Você precisa de **alguns dispositivos macOS** conectados às Mensagens. Ele **não** precisa ser um Mac mini -
qualquer Mac funciona. **Use [BlueBubbles](/channels/bluebubbles)** (recomendado) para iMessage - o servidor BlueBubbles é executado no macOS, enquanto o Gateway pode ser executado no Linux ou em outro lugar.

Configurações comuns:

- Execute o Gateway no Linux/VPS, e execute o servidor BlueBubbles em qualquer Mac conectado às Mensagens.
- Execute tudo no Mac se você quiser a configuração de máquina mais simples.

Documentos: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes),
[Modo remoto Mac](/platforms/mac/remote).

### Se eu comprar um mini Mac para executar o OpenClaw posso conectá-lo ao meu MacBook Pro

Sim. O **mini Mac Mac pode executar o Gateway** e seu MacBook Pro pode se conectar como um **nó**
(dispositivo companion). Nós não executam o Gateway - eles fornecem recursos
extras como tela/camera/canvas e `system.run` nesse dispositivo.

Padrão comum:

- Gateway no Mac mini (sempre).
- O MacBook Pro executa o aplicativo macOS ou um host de nós e pares para o Gateway.
- Use `openclaw nodes status` / `openclaw nodes list` para vê-lo.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Eu posso usar o Coque

Bun **não é recomendado**. Vemos erros de execução, especialmente com WhatsApp e Telegram.
Use **Node** para gateways estáveis.

Se você ainda deseja experimentar a Bun, faça isso em um gateway que não é produção
sem WhatsApp/Telegram.

### Telegram o que sai allowDe

`channels.telegram.allowFrom` é **o ID de usuário do remetente humano** (numérico, recomendado) ou `@username`. Não é um nome de usuário bot.

Mais seguro (sem bot de terceiros):

- DM seu bot, então rode `openclaw logs --follow` e leia `from.id`.

API oficial do bot:

- DM seu bot, em seguida, chame `https://api.telegram.org/bot<bot_token>/getUpdates` e leia `message.from.id`.

Terceiros (menos privado):

- DM `@userinfobot` or `@getidsbot`.

Veja [/channels/telegram](/channels/telegram#access-control-dms--groups).

### Pode várias pessoas usar um número de WhatsApp com diferentes instâncias OpenClaw

Sim, através de **roteamento com vários agentes**. Vincule o WhatsApp de cada remetente **DM** (`tyd: "dm"`, remetente E. 64 como `+15551234567`) para um `agentId` diferente, para que cada pessoa obtenha sua própria área de trabalho e loja de sessão. As respostas ainda vêm da **mesma conta do WhatsApp** e do controle de acesso do DM (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) é global por conta do WhatsApp. Veja [Roteamento do Multiagente](/concepts/multi-agent) e [WhatsApp](/channels/whatsapp).

### Posso executar um rápido agente de bate-papo e um Opus para codificar

Sim. Usar roteamento de vários agentes: dê a cada agente seu próprio modelo padrão e, em seguida, vincule rotas de entrada (conta de provedor ou pares específicos) a cada agente. Um exemplo de configuração vive no [Multi-Agent Routing](/concepts/multi-agent). Ver também [Models](/concepts/models) e [Configuration](/gateway/configuration).

### O Homebrew funciona no Linux

Sim. O Homebrew suporta Linux (Linuxbrew). Início rápido:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install install <formula>
```

Se você executar o OpenClaw via systemd, assegure-se do serviço PATH incluir `/home/linuxbrew/.linuxbrew/bin` (ou seu prefixo de brew), então as ferramentas instaladas 'brew' resolvem em shells não logins.
Builds recentes também preferem o número de usuários comuns nos serviços de sistema do Linux (por exemplo, `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/. un/bin`) e honra `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR`, e `FNM_DIR` quando definido.

### Qual é a diferença entre a instalação git hackeável e a instalação npm

- **Instalação Hackable (git):** compra de fonte completa, editável, melhor para colaboradores.
  Você executa compilações localmente e pode corrigir código/docs.
- **npm install:** global CLI instala, sem repositório, melhor para "just run it."
  Atualizações vêm de npm dist-tags.

Documentos: [Primeiros passos](/start/getting-started), [Updating](/install/updating).

### Posso alternar entre instalações npm e git mais tarde

Sim. Instale o outro sabor, então execute o Doutor para que o serviço de gateway aponte para o novo ponto de entrada.
Isto **não apaga seus dados** - apenas altera o código OpenClaw instalado. Seu estado
(`~/.openclaw`) e espaço de trabalho (`~/.openclaw/workspace`) permanecem intactos.

Do npm → git:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw doctor
openclaw gateway reinicie
```

Do git → npm:

```bash
npm install -g openclaw@latest
openclaw doctor
Reiniciar o gateway openclaw
```

O Doutor detecta um incompatibilidade de serviço de entrada de ponto de gateway e oferece reescrever a configuração de serviço para corresponder à instalação atual (use `--repair` em automação).

Dicas de backup: veja [Estratégia de backup](/help/faq#whats-the-recommended-backup-strategy).

### Devo executar o Gateway no meu computador portátil ou um VPS

Resposta curta: **se você quiser confiabilidade 24/7, use um VPS**. Se você quer a
menor fricção e você está bem com sono/reinicia, execute-a localmente.

**Notebook (Gateway local)**

- **Perfis:** nenhum custo de servidor, acesso direto a arquivos locais, janela do navegador ao vivo.
- **Confirma:** drops de rede / sono/sono = desconectar, atualizações / reboots interromper, devem ficar acordados.

**VPS / nuvem**

- **Pros:** rede estável, sempre ligada, sem problemas de sono de laptop, mais fácil de continuar rodando.
- **Cons.**: geralmente execute headless (use screenshots), somente acesso a arquivos remotos, você deve fazer SSH para atualizações.

**Nota específica do OpenClaw:** WhatsApp/Telegram/Slack/Mattermost (plugin)/Discord tudo corre bem em um VPS. A única troca real é **navegador sem cabeças** contra uma janela visível. Ver [Browser](/tools/browser).

**Recomendado padrão:** VPS se você teve desconexões de gateway antes. Local é ótimo quando você usa o Mac e quer acesso local a arquivos ou automação de interface de usuário com um navegador visível.

### Quão importante é para rodar a OpenClaw em uma máquina dedicada

Não é necessário, mas **recomendado para confiabilidade e isolamento**.

- **Host dedicado (VPS/Mac mini/Pi):** sempre-on, menos interrupções/reiniciar interrupções, permissões mais limpas, mais fácil de continuar em execução.
- **laptop/desktop compartilhado:** totalmente bom para testes e uso ativo, mas espere pausas quando a máquina dormir ou atualizar.

Se você quer o melhor dos dois mundos, mantenha o Gateway em um host dedicado e emparelhe seu laptop como um **nó** para ferramentas locais de tela/câmera/exec. Ver [Nodes](/nodes).
Por orientação da segurança, leia [Security](/gateway/security).

### Quais são os requisitos mínimos do VPS e do SO recomendado

O OpenClaw é leve. Para um Gateway básico + um canal de chat:

- **Mínimo absoluto:** 1 vCPU, 1GB RAM, ~500MB de disco.
- **Recomendado:** 1-2 vCPU, 2GB RAM ou mais para quartos de ouvido (logs, mídia, vários canais). Ferramentas de nó e automação do navegador podem ter fome de recursos.

SO: use **Ubuntu LTS** (ou qualquer Debian/Ubuntu) moderno). O caminho de instalação do Linux é o mais testado lá.

Documentos: [Linux](/platforms/linux), [VPS hosting](/vps).

### Posso executar o OpenClaw em uma VM e quais são os requisitos

Sim. Tratar uma VM da mesma forma que um VPS: ela precisa estar sempre ligada, acessível, e tenha
RAM suficiente para o Gateway e quaisquer canais que você ativar.

Orientação baseline:

- **Mínimo absoluto:** 1 vCPU, 1GB de RAM.
- **Recomendado:** 2GB RAM ou mais se você executar vários canais, automação do navegador ou ferramentas de mídia.
- **OS:** Ubuntu LTS ou outro Debian/Ubuntu.

If you are on Windows, **WSL2 is the easiest VM style setup** and has the best tooling
compatibility. Ver [Windows](/platforms/windows), [VPS hosting](/vps).
Se você estiver executando o macOS em uma VM, veja [macOS VM](/install/macos-vm).

## O que é o OpenClaw?

### O que é o OpenClaw em um parágrafo

OpenClaw é um assistente AI pessoal que você roda em seus próprios dispositivos. Ele responde nas superfícies de mensagens que você já usa (WhatsApp, Telegram, Slack, Mattermost (plugin), Discord, O Google Chat, Signal, iMessage, WebChat) e também pode fazer voz + uma tela ao vivo nas plataformas suportadas. O **Gateway** é o avião que controla sempre; o assistente é o produto.

### Qual é a proposta de valor

O OpenClaw não é "apenas um invólucro tremendo." É um **plano de controle local** que permite executar um assistente
capaz em **seu próprio hardware**, acessível a partir dos aplicativos de bate-papo que você já usa. com
sessões com estado, memória e ferramentas - sem transmitir controle de seus fluxos de trabalho a um
SaaS.

Destaques:

- **Seus dispositivos, seus dados:** rode o Gateway onde quiser (Mac, Linux, VPS) e mantenha o espaço* histórico de sessões local.
- **Canais reais, não uma sandbox web:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc,
  mais voz móvel e tela nas plataformas suportadas.
- **Model-agnostic:** use Anthropic, OpenAI, MiniMax, OpenRouter, etc com o roteamento por agente
  e falhe.
- **Opção somente local:** execute modelos locais para que **todos os dados possam ficar em seu dispositivo** se você quiser.
- Roteamento de agentes de origem:\*\* separe agentes por canal, conta, ou tarefa, cada um com seu próprio
  espaço de trabalho e padrões.
- **Código aberto e hackeável:** inspeção, expansão e auto-hospedeiro sem o fornecedor bloqueio.

Documentos: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
[Memory](/concepts/memory).

### Eu acabei de configurar o que devo fazer primeiro

Bons primeiros projetos:

- Construa um site (WordPress, Shopify ou um site estático simples).
- Prototype um aplicativo móvel (esboço, screens, plano API).
- Organizar arquivos e pastas (limpeza, nomes, marcação).
- Conecte o Gmail e automatize resumos ou acompanhe.

Pode lidar com tarefas grandes, mas funciona melhor quando você as divide em fases e
usa sub agentes para trabalho paralelo.

### Quais são os cinco melhores casos de uso diário para OpenClaw

Todos os dias as vitórias normalmente se parecem:

- **Informações pessoais:** resumos da caixa de entrada, calendário e notícias sobre as quais você se importa.
- **Pesquisa e rascunho:** pesquisa rápida, resumos e primeiros rascunhos para e-mails ou documentos.
- **Lembretes e acompanhe-as:** empurrões ou pulso de pepitas e listas de verificação.
- **Automação do navegador:** preenchimento de formulários, coleta de dados e repetição de tarefas web.
- **Coordenação de dispositivo cruzado:** envie uma tarefa do seu celular, deixe o Gateway executá-lo em um servidor e obtenha o resultado de volta no chat.

### Pode o OpenClaw ajudar com anúncios de divulgação de geração de chumbo e blogs para um SaaS

Sim para **pesquisa, qualificação e esboço**. Ele pode escanear sites, criar listas curtas,
resumir perspectivas e escrever rascunhos de divulgação ou cópia de anúncio.

Para **divulgação ou corrida de anúncios**, mantenha um humano no loop. Evite spam, siga as leis locais e as políticas da plataforma
e revise qualquer coisa antes de ser enviado. O padrão mais seguro é deixar o projeto
OpenClaw e você aprovar.

Documentos: [Security](/gateway/security).

### Quais são as vantagens vs Claude Code para desenvolvimento web

O OpenClaw é um **assistente pessoal** e uma camada de coordenação, não uma substituição do IDE. Use
Claude Code ou Codex para o loop de codificação direto mais rápido dentro de um repo. Use OpenClaw when you
want durable memory, cross-device access, and tool orchestration.

Vantagens:

- **Memória persistente + espaço de trabalho** entre sessões
- Acesso à plataforma\*\* (WhatsApp, Telegram, TUI, WebChat)
- **Orquestração de ferramentas** (navegador, arquivos, agendamento, hooks)
- **Gateway sempre ligado** (rode em um VPS, interação de qualquer lugar)
- **Nós** para navegador/tela/câmera/exec local

Mostruário: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## Habilidades e automação

### Como faço para customizar as habilidades sem manter o repo sujo

Use substituições gerenciadas em vez de editar a cópia do repositório. Coloque suas mudanças em `~/.openclaw/skills/<name>/SKILL.md` (ou adicione uma pasta via `skills.load.extraDirs` em `~/.openclaw/openclaw.json`). A precariedade é `<workspace>/skills` > `~/.openclaw/skills` > empacotado, então gerenciado substitui a vitória sem tocar no git. Apenas edições dignas de montante devem viver no repositório e sair como RP.

### Posso carregar habilidades de uma pasta personalizada

Sim. Adiciona diretórios extras via `skills.load.extraDirs` em `~/.openclaw/openclaw.json` (precedência mais baixa). Prioridade padrão resta: `<workspace>/skills` → `~/.openclaw/skills` → bundled → `skills.load.extraDirs`. `clawhub` instala em `./skills` por padrão, que OpenClaw trata como `<workspace>/skills`.

### Como posso usar modelos diferentes para diferentes tarefas

Hoje os padrões suportados são:

- **Tarefas crônicas**: tarefas isoladas podem definir uma substituição `model` por tarefa.
- **Sub-agentes**: rotear tarefas para separar agentes com diferentes modelos padrão.
- **Interruptor de demanda**: use `/model` para mudar o atual modelo de sessão a qualquer momento.

Veja [Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent), e [Slash commands](/tools/slash-commands).

### O bot congela enquanto faz trabalho pesado como eu descarrego isso

Use **sub-agentes** para tarefas longas ou paralelas. Sub-agentes executam em sua própria sessão,
retorna um resumo e mantém seu chat principal responsivo.

Peça ao seu bot para "gerar um subagente para esta tarefa" ou use `/subagents`.
Use `/status` no chat para ver o que o Gateway está fazendo agora (e esteja ocupado).

Dica de token: tarefas longas e sub-agentes ambos consomem tokens. Se o custo for uma preocupação, defina um modelo
mais barato para subagentes através de `agents.defaults.subagents.model`.

Documentos: [Sub-agents](/tools/subagents).

### Cron ou lembretes não disparam o que eu devo verificar

Cron é executado dentro do processo de gateway. Se o Gateway não estiver funcionando continuamente,
trabalhos agendados não serão executados.

Checklist:

- O cron de confirmação está ativado (`cron.enabled`) e `OPENCLAW_SKIP_CRON` não está definido.
- Verifique se o Gateway está rodando 24/7 (sem sono/reinicialização).
- Verifique as configurações de fuso horário para a tarefa (`--tz` vs fuso horário).

Debug:

```bash
openclaw cron roda <jobId> --force
openclaw roda --id <jobId> --limit 50
```

Documentos: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat).

### Como faço para instalar habilidades no Linux

Use **ClawHub** (CLI) ou solte habilidades no seu espaço de trabalho. A interface de Habilidades do macOS não está disponível no Linux.
Procurar habilidades em [https://clawhub.com](https://clawhub.com).

Instale o ClawHub CLI (selecione um gerenciador de pacotes):

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### Pode OpenClaw executar tarefas em um horário ou continuamente em segundo plano

Sim. Use o agendamento do Gateway:

- **Tarefas duplicadas** para tarefas agendadas ou recorrentes (persistir em reinícios).
- **Heartbeat** para verificações periódicas de "sessão principal".
- **Trabalhos isolados** para agentes autônomos que postam resumos ou entregam no chat.

Documentos: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat),
[Heartbeat](/gateway/heartbeat).

### Posso executar habilidades somente macOS da Apple no Linux?

Não diretamente. As habilidades de macOS são portadas por `metadata.openclaw.os` mais os binários necessários, e as habilidades só aparecem no prompt do sistema quando elas são elegíveis no **host de Gatewa**. No Linux, `darwin`-only skills (como `apple-notes`, `apple-reminders`, `things-mac`) não serão carregadas a não ser que você substitua o portão.

Você tem três padrões suportados:

\*\*Opção A - execute o Gateway em um Mac (mais simples). \*
Rode o Gateway onde os binários do macOS existem, depois conecte-se a partir de Linux no [modo remoto](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) ou através da cauda. A carga de habilidades normalmente porque o host do Gateway é macOS.

\*\*Opção B - use um nó macOS (sem SSH). \*
Rode o Gateway no Linux, emparelhe um nó de macOS (aplicativo de menus), e selecione **Node Run Commands** para "Always Ask" ou "Always Allow" no Mac. O OpenClaw pode tratar habilidades macOS apenas como elegíveis quando os binários necessários existem no nó. O agente executa essas habilidades através da ferramenta `nós`. Se você escolher "Sempre Perguntar", aprovando "Sempre Permitir" no prompt adiciona esse comando à lista de permissões.

**Option C - proxy macOS binaries over SSH (advanced).**
Keep the Gateway on Linux, but make the required CLI binaries resolve to SSH wrappers that run on a Mac. Em seguida, substitua a habilidade para permitir o Linux, para que permaneça elegível.

1. Crie um wrapper SSH para o binário (exemplo: `memo` para Apple Notes):

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```

2. Coloque o wrapper em `PATH` no host Linux (por exemplo `~/bin/memo`).

3. Sobrepor os metadados de habilidade (espaço de trabalho ou `~/.openclaw/skills`) para permitir Linux:

   ```markdown
   ---
   nome: apple-notes
   descrição: Gerencie Notas do Apple via memo CLI no macOS.
   metadados: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] }
   ---
   ```

4. Comece uma nova sessão para que o instantâneo de habilidades seja atualizado.

### Você tem uma integração Notion ou HeyGen

Não está integrado hoje.

Opções:

- **Habilidade personalizada / plugin:** melhor para acesso de API confiável (Nota/HeyGen ambos possuem APIs).
- **Automação do navegador:** funciona sem código, mas é mais lento e mais frágil.

Se você deseja manter o contexto por cliente (fluxos de trabalho das agências), um padrão simples é:

- Uma página de Notação por cliente (contexto + preferências + trabalho ativo).
- Peça ao agente que busque essa página no início de uma sessão.

Se você quer uma integração nativa, abra uma solicitação de recurso ou crie uma habilidade
direcionada a essas APIs.

Instale habilidades:

```bash
instalar clawhub <skill-slug>
atualização do clawhub --all
```

ClawHub instala-se em `. habilidades` sob o seu diretório atual (ou voltam para o seu espaço de trabalho OpenClaw configurado); OpenClaw trata isso como `<workspace>/skills` na próxima sessão. Para habilidades compartilhadas entre agentes, coloque-as em `~/.openclaw/skills/<name>/SKILL.md`. Algumas habilidades esperam binários instalados via Homebrew; no Linux, o que significa Linuxbrew (veja a entrada de FAQ do Homebrew Linux acima). Ver [Skills](/tools/skills) e [ClawHub](/tools/clawhub).

### Como faço para instalar a extensão Chrome para aquisição do navegador

Use o instalador interno, então carregue a extensão não empacotada no Chrome:

```bash
openclaw browser extension install
openclaw browser extension path
```

Então Chrome → `chrome://extensions` → habilite "Modo de desenvolvedor" → "Load unpacked" → escolha essa pasta.

Guia completo (incluindo notas de gateway remoto + segurança): [Extensão do Chrome](/tools/chrome-extension)

Se o Gateway é executado na mesma máquina que o Chrome (configuração padrão), você normalmente **não** precisa de nada a mais.
Se o Gateway rodar em outro lugar, execute um host de nó na máquina do navegador para que o Gateway possa fazer proxy das ações do navegador.
Você ainda precisa clicar no botão extensão na aba que você deseja controlar (não se anexa automaticamente).

## Sandboxing e memória

### Existe um documento dedicado de areia

Sim. Veja [Sandboxing](/gateway/sandboxing). Para configuração específica do Docker (gateway completo no Docker ou sandbox images), veja [Docker](/install/docker).

### O Docker parece limitado como eu faço para ativar todos os recursos

The default image is security-first and runs as the `node` user, so it does not
include system packages, Homebrew, or bundled browsers. Para uma configuração completa:

- Persistir `/home/node` com `OPENCLAW_HOME_VOLUME` então os caches sobrevivem.
- Assar o sistema depende da imagem com `OPENCLAW_DOCKER_APT_PACKAGES`.
- Instale os navegadores Playwright através do pacote CLI:
  `node /app/node_modules/playwright-core/cli.js install chromium`
- Defina `PLAYWRIGHT_BROWSERS_PATH` e certifique-se de que o caminho seja mantido.

Documentos: [Docker](/install/docker), [Browser](/tools/browser).

**Posso manter DMs pessoais, mas tornar grupos públicos com um agente**

Sim - se seu tráfego privado for **DMs** e seu tráfego público for **grupos**.

Use `agents.defaults.sandbox.mode: "non-main"` para que as sessões de grupo/canal (chaves não-principais) executem em Docker, enquanto a sessão DM principal permanece no host. Em seguida, restringir que ferramentas estão disponíveis em sessões sandboxed através de `tools.sandbox.tools`.

Configuração walkthrough + configuração de exemplo: [Grupos: DMs pessoais + grupos públicos](/channels/groups#pattern-personal-dms-public-groups-single-agent)

Referência de configuração chave: [Configuração do Gateway](/gateway/configuration#agentsdefaultssandbox)

### Como vincular uma pasta de host na sandbox

Defina `agents.defaults.sandbox.docker.binds` para `["host:path:mode"]` (por exemplo, `"/home/user/src:/src:ro"`). Global + por-agente se vincula a merge; ligações por agente são ignoradas quando `escopo: "compartilhado"`. Use `:ro` para qualquer coisa sensível e lembre-se de amarras ignoram as paredes do sistema de arquivos do sandbox. Veja [Sandboxing](/gateway/sandboxing#custom-bind-mounts) e [Sandbox vs Tool Policy vs Elevado](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) para exemplos e notas de segurança.

### Como funciona a memória

Memória do OpenClaw é apenas arquivos Markdown na área de trabalho do agente:

- Notas diárias em `memória/YYYY-MM-DD.md`
- Notas curadas de longo prazo em `MEMORY.md` (apenas sessões principais/privadas)

OpenClaw também executa um **liberador silencioso de memória de pré-compacta** para lembrar o modelo
de escrever notas duráveis antes da compactação automática. Isso só é executado quando o espaço de trabalho
é gravável (sandboxes com somente leitura pula-lo). Veja [Memória](/concepts/memory).

### A memória continua esquecendo as coisas como eu faço ele ficar.

Peça ao bot para **escrever o fato à memória**. Notas de longo prazo pertencem a `MEMORY.md`,
contexto de curto prazo entra em `memory/YYYY-MM-DD.md`.

Esta é uma área que ainda estamos a melhorar. Ele ajuda a lembrar o modelo para armazenar memórias;
ele vai saber o que fazer. If it keeps forgetting, verify the Gateway is using the same
workspace on every run.

Documentos: [Memory](/concepts/memory), [Espaço do representante](/concepts/agent-workspace).

### A pesquisa semântica de memória requer uma chave de API OpenAI

Somente se você usar **OpenAI embeddings**. Codex OAuth cobre chat/compleções e
**não** concede acesso a incorporações, então **entrar com o Codex (OAuth ou o
Codex CLI login)** não ajuda na busca de memória semântica. A incorporação do OpenAI
ainda precisa de uma chave de API real (`OPENAI_API_KEY` ou `models.providers.openai.apiKey`).

Se você não definir um provedor explicitamente, o OpenClaw auto-seleciona um provedor quando ele
pode resolver uma chave de API (perfis de autenticação, `models.providers.*.apiKey`, ou varias de env).
Prefere OpenAI se uma chave OpenAI resolver, caso contrário o Gemini se uma chave
resolve. If neither key is available, memory search stays disabled until you
configure it. Se você tem um caminho de modelo local configurado e presente, OpenClaw
prefere `local`.

Se você prefere permanecer local, coloque `memorySearch.provider = "local"` (e opcionalmente
`memorySearch.fallback = "none"`). Se você quer incorporações do Gemini, defina
`memorySearch.provider = "gemini"` e forneça `GEMINI_API_KEY` (ou
`memorySearch.remote.apiKey`). Oferecemos suporte a **OpenAI, Gemini, ou local** incorporando
models - veja [Memory](/concepts/memory) para os detalhes de configuração.

### Faz memória persistir para sempre quais são os limites

Arquivos de memória vivem em disco e persistem até você excluí-los. O limite é seu
armazenamento, não o modelo. O **contexto da sessão** ainda está limitado pelo modelo
janela de contexto, então conversas longas podem compactar ou truncar. É por isso que
existe pesquisa de memória - ela puxa apenas as partes relevantes de volta ao contexto.

Documentos: [Memory](/concepts/memory), [Context](/concepts/context).

## Onde as coisas vivem em disco

### Todos os dados são usados com o OpenClaw salvo localmente

Não - **O estado do OpenClaw's é local**, mas **serviços externos ainda vêem o que você os envia**.

- **Local por padrão:** sessões, arquivos de memória, configuração e espaço de trabalho ao vivo no host de Gateway
  (`~/.openclaw` + seu diretório de workspace).
- **Remoto por exigência:** mensagens que você envia para provedores de modelos (Anthropic/OpenAI/etc.) Acesse
  suas APIs e plataformas de bate-papo (WhatsApp/Telegram/Slack/etc.) armazenar dados da mensagem em seus servidores
  .
- **Você controla o rasto:** usando modelos locais mantém os alertas em sua máquina, mas o tráfego
  ainda passa pelos servidores do canal.

Relacionado: [Espaço do representante](/concepts/agent-workspace), [Memory](/concepts/memory).

### Onde o OpenClaw armazena seus dados

Tudo mora abaixo de `$OPENCLAW_STATE_DIR` (padrão: `~/.openclaw`):

| Caminho                                                         | Propósito                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | Configuração principal (JSON5)                                           |
| `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | Importação de OAuth antiga (copiada para perfis de auth no primeiro uso) |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | Perfis de autenticação (OAuth + chaves de API)                           |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | Cache de autenticação de tempo de execução (gerenciado automaticamente)  |
| `$OPENCLAW_STATE_DIR/credentials/`                              | Estado do provedor (por exemplo, `whatsapp/<accountId>/creds.json`)      |
| `$OPENCLAW_STATE_DIR/agents/`                                   | Estado por agente (agentDir + sessões)                                   |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | Histórico e estado da conversa (por agente)                              |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | Metadados da sessão (por agente)                                         |

Caminho de um agente único legado: `~/.openclaw/agent/*` (migated por `openclaw doctor`).

Seu **espaço de trabalho** (AGENTS.md, arquivos de memória, habilidades, etc.) é separado e configurado através de 'agents.defaults.workspace' (padrão: '~/.openclaw/workspace').

### Onde deve viver o USUÁRIO AGENTSmd SOULmd

Esses arquivos vivem na **área de trabalho do agente**, não `~/.openclaw`.

- **Área de trabalho (por agente)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMORY.md` (ou `memory.md`), `memory/YYYY-MM-DD.md`, `HEARTBEAT.md` opcional.
- **Diretório de Estado (`~/.openclaw`)**: configuração, credenciais, perfis de autenticação, sessões, logs,
  e habilidades compartilhadas (`~/.openclaw/skills`).

Área de trabalho padrão é `~/.openclaw/workspace`, configurável via:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

Se o bot "esquecer" após a reinicialização, confirmar que o Gateway está usando o mesmo
espaço de trabalho a cada lançamento (e lembre-se: o modo remoto usa o **host de gateway**
área de trabalho, não seu computador portátil local).

Dica: se você quer um comportamento durável ou preferência, peça ao bot para **escrevê-lo no
AGENTS. d ou MEMORY.md** ao invés de depender de histórico de bate-papo.

Ver [Espaço do Agente](/concepts/agent-workspace) e [Memory](/concepts/memory).

### Qual é a estratégia de backup recomendada

Coloque seu **agente de área de trabalho** em um repositório **privado** e faça backup dele em algum lugar
privado (por exemplo, o GitHub private). Isso captura a memória + AGENTS/SOUL/USER
e permite que você restaure os "mente" do assistente mais tarde.

**não** comprometa nada sob `~/.openclaw` (credenciais, sessões, tokens).
Se você precisar de uma restauração completa, faça backup do espaço de trabalho e do diretório
separadamente (veja a questão de migração acima).

Documentos: [Espaço do representante](/concepts/agent-workspace).

### Como eu desinstalar completamente o OpenClaw

Veja o guia dedicado: [Uninstall](/install/uninstall).

### Pode agentes trabalhar fora do espaço de trabalho

Sim. O espaço de trabalho é o **canhão padrão** e a âncora de memória, não um sandbox difícil.
Caminhos relativos resolvem dentro da área de trabalho, mas caminhos absolutos podem acessar outros
locais de hospedagem a menos que a sandboxing esteja ativada. Se você precisar de isolamento, use
[`agents.defaults.sandbox`](/gateway/sandboxing) ou configurações sandbox por agente. Se você
quer que um repositório seja o diretório de trabalho padrão, aponte a área de trabalho
do agente para a raiz do repositório. O repositório OpenClaw é apenas um código fonte; mantenha o espaço de trabalho
separado, a menos que você queira que o agente trabalhe dentro dele.

Exemplo (repo como cwd padrão):

```json5
{
  agentes: {
    padrões: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### Im no modo remoto onde está a sessão da loja

Estado da sessão é propriedade do **host de entrada**. Se você estiver em modo remoto, a loja de sessões que lhe interessa está na máquina remota, não no seu laptop local. Ver [Gerenciamento de Sessão](/concepts/session).

## Básico de configuração

### Qual é o formato da configuração onde está

O OpenClaw lê uma configuração **JSON5** opcional do `$OPENCLAW_CONFIG_PATH` (padrão: `~/.openclaw/openclaw.json`):

```
$OPENCLAW_CONFIG_PATH
```

Se o arquivo está faltando, ele usa padrões de segurança (incluindo um espaço de trabalho padrão de '~/.openclaw/workspace').

### Eu defino gatewaybind lan ou tailnet e agora nada ouve a interface do usuário dizer não autorizado

Non-loopback binds **requer auth**. Configure `gateway.auth.mode` + `gateway.auth.token` (ou use `OPENCLAW_GATEWAY_TOKEN`).

```json5
{
  gateway: {
    bind: "lan",
    auth: {
      mode: "token",
      token: "replace-me",
    },
  },
}
```

Notes:

- O `gateway.remote.token` é apenas para **chamadas remotas do CLI**; ele não permite autora do gateway local.
- A UI de Controle autentica via `connect.params.auth.token` (armazenada nas configurações de app/UI). Evite colocar tokens em URLs.

### Por que preciso de um token no localhost agora

O assistente gera um token de gateway por padrão (mesmo no loopback), então **clientes WS locais devem autenticar**. Isso bloqueia outros processos locais de chamar o Gateway. Cole o token nas configurações da interface do usuário de controle (ou na configuração do cliente) para se conectar.

Se você **realmente** quer loopback aberto, remova `gateway.auth` da sua configuração. O doutor pode gerar um token para você a qualquer momento: `openclaw doctor --generate-gateway-token`.

### Tenho que reiniciar depois de alterar a configuração

O Gateway observa a configuração e suporta hot-reload:

- `gateway.reload.mode: "híbrido"` (padrão): aplicar alterações seguras, reinicie para as críticas
- `hot`, `restart`, `off` também são suportados

### Como faço para habilitar a pesquisa web e buscar web

O 'web_fetch' funciona sem uma chave de API. `web_search` requer uma chave da API
de Pesquisa Brave. **Recomendado:** execute `openclaw configure --section web` para armazená-lo em
`tools.web.search.apiKey`. Alternativa ambiental: defina `BRAVE_API_KEY` para o processo de Ingressos
.

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
      },
      fetch: {
        enabled: true,
      },
    },
  },
}
```

Notes:

- Se você usa allowlists, adicione `web_search`/`web_fetch` ou `group:web`.
- `web_fetch` é habilitado por padrão (a menos que seja explicitamente desabilitado).
- Daemons lê vars env de `~/.openclaw/.env` (ou o ambiente de serviço).

Documentação: [Web tools](/tools/web).

### Como faço para executar um Gateway central com trabalhadores especializados em dispositivos

O padrão comum é **um Gateway** (por exemplo, Raspberry Pi) mais **nós** e **agents**:

- **Gateway (central):** possui canais (Signal/WhatsApp), roteamento e sessões.
- **Nós (dispositivos):** Macs/iOS/Android conecta como periféricos e expõe as ferramentas locais (`system.run`, `canvas`, `camera`).
- **Agentes (trabalhadores):** separar brains/espaços de trabalho para papéis especiais (por exemplo, "Hetzner ops", "Dados pessoais").
- **Subagentes:** spawnar trabalho em segundo plano de um agente principal quando você quiser paralelismo.
- **TUI:** conectar ao Gateway e alternar agentes/sessões.

Documentos: [Nodes](/nodes), [Acesso remoto](/gateway/remote), [Roteamento do Multiagente](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

### Pode o navegador OpenClaw rodar sem cabeça

Sim. É uma opção de configuração:

```json5
{
  browser: { headless: true },
  agentes: {
    defaults: {
      sandbox: { browser: { headless: true } },
    },
  },
}
```

O padrão é `false` (cabeçalho). É mais provável que o anti-bot verifique em alguns sites. Ver [Browser](/tools/browser).

O Headless usa o \*\*mesmo mecanismo Chromium \*\* e funciona para a maior parte da automação (formulários, cliques, sucata, logins). As principais diferenças:

- Nenhuma janela visível do navegador (use capturas de tela se você precisar de visuais).
- Alguns sites são mais rigorosos em relação à automação em modo não-interativo (CAPTCHAs, anti-bot).
  Por exemplo, X/Twitter muitas vezes bloqueia sessões sem abrigo.

### Como eu uso o Brave para o controle do navegador

Defina `browser.executablePath` para o seu binário Brave (ou qualquer navegador baseado no Chromium) e reinicie o Gateway.
Veja os exemplos completos de configuração em [Browser](/tools/browser#use-brave-or-another-chromium-based-browser).

## gateways e nós remotos

### Como os comandos se propagam entre o Telegram o gateway e os nós

Mensagens do Telegram são tratadas pelo **gateway**. O gateway executa o agente e
só então chama nós pelo **Portal WebSocket** quando uma ferramenta nó é necessária:

Telegram → Gateway → Agent → `node.*` → Node → Gateway → Telegram

Nós não veem o tráfego do provedor de entrada; eles recebem apenas chamadas RPC do nó.

### Como meu agente pode acessar o meu computador se o Gateway está hospedado remotamente

Resposta curta: **emparelhe seu computador com um nó**. O Gateway corre em outro lugar, mas pode
chamar ferramentas `node.*` (tela, câmera, sistema) na sua máquina local sobre o Gateway WebSocket.

Configuração típica:

1. Execute o Gateway no host sempre ativo (VPS/servidor residente).
2. Coloque o host de Gateway + seu computador na mesma rede.
3. Certifique-se de que o Gateway WS esteja acessível (conexão com a rede ou túnel SSH).
4. Abra o aplicativo macOS localmente e conecte-se ao modo **Remoto por SSH** (ou cauda direta)
   para que possa se registrar como um nó.
5. Aprovar o nó no Gateway:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Nenhuma ponte TCP separada é necessária; nós conectam através do Gateway WebSocket.

Lembrete de segurança: emparelhar um nó macOS permite o `system.run` nessa máquina. Somente
emparelhe os dispositivos em que confia, e analise [Security](/gateway/security).

Documentos: [Nodes](/nodes), [protocolo do Gateway](/gateway/protocol), [modo remoto macOS](/platforms/mac/remote), [Security](/gateway/security).

### Escala Caudal está conectada, mas não recebo respostas o que agora

Verifique o básico:

- Gateway está funcionando: `openclaw gateway status`
- Saúde do Gateway: `openclaw status`
- Saúde do canal: `status dos canais de openclaw`

Em seguida, verifique a autenticação e roteamento:

- Se você usar o Serviço de Escala, certifique-se que o `gateway.auth.allowTailscale` está configurado corretamente.
- Se você se conectar através do túnel SSH, confirme que o túnel local está pronto no porto certo.
- Confirme suas listas de permissões (DM ou grupo) inclua sua conta.

Documentos: [Tailscale](/gateway/tailscale), [Acesso remoto](/gateway/remote), [Channels](/channels).

### Pode duas instâncias OpenClaw conversarem entre si com VPS local

Sim. There is no built-in "bot-to-bot" bridge, but you can wire it up in a few
reliable ways:

**Simples:** use um canal de chat normal que ambos os bots podem acessar (Telegram/Slack/WhatsApp).
Faça o Bot A enviar uma mensagem para o Bot B, então deixe o Bot B responder como de costume.

**Ponte CLI (genérica):** execute um script que chame o outro Gateway com
`openclaw agent --message ... --deliver`, direcionando para um chat onde o outro bot
escuta. If one bot is on a remote VPS, point your CLI at that remote Gateway
via SSH/Tailscale (see [Remote access](/gateway/remote)).

Exemplo de padrão (execute a partir de uma máquina que pode alcançar o Gateway alvo):

```bash
openclaw agent --message "Olá do bot local" --deliver --channel telegram --reply-to <chat-id>
```

Dica: adicione um guardrail para que os dois bots não façam loop infinitamente (apenas mencionar, canalize
listas permitidas, ou a regra "não responda mensagens do bot").

Documentos: [Acesso remoto](/gateway/remote), [CLI](/cli/agent), [Envio do agente](/tools/agent-send).

### Preciso de VPSes separados para vários agentes

Não. Um Gateway pode hospedar vários agentes, cada um com seu próprio espaço de trabalho, padrões modelo,
e roteamento. Essa é a configuração normal e é muito mais barata e simples do que rodar
um VPS por agente.

Use VPSes separados somente quando você precisa de isolamento duro (limites de segurança) ou muito
configurações diferentes que você não deseja compartilhar. Caso contrário, mantenha um Gateway e
usa vários agentes ou sub-agentes.

### Existe algum benefício em usar um nó no meu laptop pessoal em vez de SSH de um VPS

Sim - nós são a maneira primeira de alcançar seu laptop a partir de um Gateway remoto, e eles
desbloqueiam mais do que acesso shell. O Gateway é executado no macOS/Linux (Windows via WSL2) e é
leve (um pequeno VPS ou Raspberry Pi-class box está bem; 4 GB RAM é bastante), então uma configuração comum
é um host sempre ativo mais o seu laptop como um nó.

- **Nenhuma entrada SSH é necessária.** Nós se conectam ao Gateway WebSocket e usam o pareamento de dispositivos.
- **Controles de execução mais seguros.** O `system.run` é escolhido pelo node allowlists/approvals no laptop.
- **Mais ferramentas do dispositivo.** Nós expõe `canvas`, `câmera`, e `tela` além de `system.run`.
- \*\*Automatização do navegador local. \* Mantenha o Gateway em um VPS, mas execute o Chrome localmente e controle de relé
  com a extensão Chrome + um host de nó no laptop.

SSH está bem para acesso ad-hoc shell, mas nós são mais simples para fluxos de trabalho de agente contínuos e para a automação
do dispositivo.

Documentos: [Nodes](/nodes), [nodes CLI](/cli/nodes), [Extensão do Chrome](/tools/chrome-extension).

### Se eu instalar em um segundo laptop ou apenas adicionar um nó

If you only need **local tools** (screen/camera/exec) on the second laptop, add it as a
**node**. Isso mantém um único Gateway e evita configurações duplicadas. Ferramentas de nó locais são
atualmente macOS, mas planejamos estendê-las a outros sistemas operacionais.

Instale um segundo Gateway apenas quando você precisar de **isolamento forte** ou dois bots completamente separados.

Documentos: [Nodes](/nodes), [nodes CLI](/cli/nodes), [Múltiplos gateways](/gateway/multiple-gateways).

### Fazer nós executar um serviço de gateway

Não. Apenas **um gateway** deve executar por host, a menos que você execute intencionalmente perfis isolados (veja [Múltiplos gateways](/gateway/multiple-gateways)). Nodes are peripherals that connect
to the gateway (iOS/Android nodes, or macOS "node mode" in the menubar app). Para hosts do node
headless e controle de CLI, consulte [Node host CLI](/cli/node).

As alterações `gateway` e `canvasHost` são necessárias a uma reinicialização completa.

### Existe uma forma de RPC API para aplicar a configuração

Sim. `config.apply` valida + grava a configuração completa e reinicia o Gateway como parte da operação.

### configapply minha configuração foi limpada como eu me recupero e evito isso

`config.apply` substitui o **configuração inteira**. If you send a partial object, everything
else is removed.

Recuperar:

- Restaurar do backup (git ou um copiado `~/.openclaw/openclaw.json`).
- Se você não tiver um backup, execute novamente o `openclaw doctor` e reconfigure os canais/modelos.
- Se isto fosse inesperado, registre um bug e inclua sua última configuração conhecida ou qualquer backup.
- Um agente de codificação local geralmente pode reconstruir uma configuração de trabalho a partir de logs ou histórico.

Evite isso:

- Use `openclaw config set` para pequenas mudanças.
- Use `openclaw configure` para edições interativas.

Documentos: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).

### Qual é o mínimo de configuração sane para uma primeira instalação

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Isto define sua área de trabalho e restringe quem pode acionar o bot.

### Como faço para configurar uma escala caudal em um VPS e conectar-se do meu Mac

Etapas mínimas:

1. **Instale + faça o login no VPS**

   ```bash
   curl -fsSL https://tailscale.com/install.sh ├sh
   sudo tailscale up
   ```

2. **Instale + faça login em seu Mac**
   - Use o aplicativo Tailscale e entre na mesma rede de cauda.

3. **Ativar MagicDNS (recomendado)**
   - No console administrativo da Escala Caudal, ative o MagicDNS para que o VPS tenha um nome estável.

4. **Use o nome de host tailnet**
   - SSH: `ssh user@your-vps.tailnet-xxxxxx.tnet`
   - Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

Se você quiser a interface de controle sem SSH, use o Serviço de Escala Caudal no VPS:

```bash
openclaw gateway --tailscale serve
```

Isso mantém o gateway ligado a um loop e expõe HTTPS através da Caudal. Ver [Tailscale](/gateway/tailscale).

### Como conectar um nó Mac a um servidor caudal de Gateway remoto

Serve expõe a **UI de Controle do Gateway + WS**. Nós conectam no mesmo ponto de extremidade da WS Gateway.

Configuração recomendada:

1. **Certifique-se de que o VPS + Mac esteja na mesma caudanet**.
2. **Use o aplicativo macOS no modo remoto** (SSH alvo pode ser o nome de host da rede tailnet).
   O app irá túnel da porta de Gateway e conectar como um nó.
3. **Aprovar o nó** do gateway:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Documentos: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).

## Env vars e carregamento de .env

### Como o OpenClaw carrega variáveis de ambiente

OpenClaw reads env vars from the parent process (shell, launchd/systemd, CI, etc.) e cargas adicionais:

- `.env` do diretório de trabalho atual
- a global fallback `.env` from `~/.openclaw/.env` (aka `$OPENCLAW_STATE_DIR/.env`)

Neither `.env` file overrides existing env vars.

Você também pode definir inline env vars na configuração (aplicado somente se faltando no processo env):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

See [/environment](/help/environment) for full precedence and sources.

### Eu comecei o Gateway através do serviço e meus vars env desapareceram o que agora

Duas correções comuns:

1. Coloque as chaves que faltam em `~/.openclaw/.env` para que elas sejam coletadas mesmo quando o serviço não herdar sua carapaça env.
2. Ativar importação do shell (opt-in convenience):

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Isso executa seu shell de login e importa apenas as chaves esperadas faltando (nunca substituições). Env var equivalentes:
`OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

### Eu parei COPILOTGITHUBTOKEN mas o status de modelos mostra Shell env off porquê

`openclaw models status` informa se **shell env import** está habilitado. "Shell env: off"
**não** significa que seus vars env estão faltando - isso significa que o OpenClaw não vai carregar
seu shell de login automaticamente.

Se o Gateway é executado como um serviço (inicializado/sistema), ele não herdará seu ambiente shell
. Corrija fazendo um desses:

1. Coloque o token em `~/.openclaw/.env`:

   ```
   COPILOT_GITHUB_TOKEN=...
   ```

2. Ou ative a importação de shell (`env.shellEnv.enabled: true`).

3. Ou adicioná-lo ao seu bloco de configuração `env` (aplica-se somente se estiver faltando).

Então reinicie o gateway e reverifique:

```bash
openclaw models status
```

Tokens Copilot são lidos de `COPILOT_GITHUB_TOKEN` (também `GH_TOKEN` / `GITHUB_TOKEN`).
Veja [/concepts/model-providers](/concepts/model-providers) e [/environment](/help/environment).

## Sessões e múltiplas conversas

### Como faço para iniciar uma conversa nova

Envie `/new` ou `/reset` como uma mensagem independente. Ver [Gerenciamento de Sessão](/concepts/session).

### Fazer sessões reiniciadas automaticamente se eu nunca enviar novas

Sim. Sessões expiram após `session.idleMinutes` (padrão **60**). A mensagem
**próxima** inicia um novo id de sessão para essa chave de bate-papo. Isso não exclui transcrições* só inicia uma nova sessão.

```json5
{
  sessão: {
    idleMinutes: 240,
  },
}
```

### Existe uma maneira de fazer uma equipe de instâncias OpenClaw um CEO e muitos agentes

Sim, através de **roteamento com vários agentes** e **subagentes**. Você pode criar um coordinator
agente e vários agentes de funcionários com seus próprios espaços de trabalho e modelos.

Dito isso, isso é melhor visto como um **experimento divertido**. É um token pesado e, muitas vezes,
menos eficiente do que usar um bot com sessões separadas. O modelo típico com o qual
sonda é um bot com quem você conversa, com diferentes sessões para trabalho paralelo. Que
bot também pode gerar sub-agentes quando necessário.

Documentos: [Roteamento de multiagentes](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agentes CLI](/cli/agents).

### Por que o contexto recebeu uma tarefa intermediária truncada, como eu previno

O contexto da sessão está limitado pela janela modelo. Long chats, large tool outputs, or many
files can trigger compaction or truncation.

O que ajuda:

- Peça ao bot para resumir o estado atual e escrevê-lo em um arquivo.
- Use `/compact` antes de tarefas longas, e `/new` ao mudar de tópicos.
- Mantenha um contexto importante na área de trabalho e peça ao bot para lê-lo de volta.
- Use subagentes para um trabalho longo ou paralelo para que o bate-papo principal permaneça menor.
- Escolha um modelo com uma janela de contexto maior se isso acontecer com frequência.

### Como faço para redefinir completamente o OpenClaw mas mantê-lo instalado

Use o comando de redefinição:

```bash
openclaw reset
```

Redefinição completa não-interativa:

```bash
openclaw reset --scope completo --yes --não-interativo
```

Então execute a integração novamente:

```bash
openclaw onboard --install-daemon
```

Notes:

- O assistente de integração também oferece **Redefinir** se ele vir uma configuração existente. Ver [Wizard](/start/wizard).
- Se você usou perfis (`--profile` / `OPENCLAW_PROFILE`), redefina cada diretório de estado (os padrões são `~/.openclaw-<profile>`).
- Dev reset: `openclaw gateway --dev --reset` (somente dev; limpa configuração dev + credenciais + sessões + espaço de trabalho).

### Estou ficando o contexto com erros muito grandes como redefinir ou compactar

Use um destes:

- **Compacta** (mantém a conversa, mas resume as curvas mais antigas):

  ```
  /compacto
  ```

  ou `/compact <instructions>` para guiar o resumo.

- **Redefinir** (ID de sessão nova para a mesma chave de chat):

  ```
  /new
  /reset
  ```

Se continuar acontecendo:

- Ativar ou ajustar **limpeza de sessão** (`agents.defaults.contextPruning`) para aparar a saída da ferramenta antiga.
- Usar um modelo com uma janela de contexto maior.

Documentos: [Compaction](/concepts/compaction), [limpeza da sessão](/concepts/session-pruning), [Gerenciamento de sessão](/concepts/session).

### Porque estou vendo solicitação LLM rejeitada messagesNcontentXtooluseinput campo obrigatório

Este é um erro de validação do provedor: o modelo emitiu um bloco `tool_use` sem o
necessário `input`. Isso geralmente significa que o histórico de sessão está obsoleto ou corrompido (muitas vezes após tópicos longos
ou uma mudança de ferramenta/esquema).

Correção: inicie uma nova sessão com `/new` (mensagem autônoma).

### Por que estou recebendo mensagens de pulso a cada 30 minutos

Heartbeats executam a cada **30m** por padrão. Ajuste ou desative-os:

```json5
{
  agentes: {
    defaults: {
      heartbeat: {
        every: "2h", // ou "0m" para desativar
      },
    },
  },
}
```

Se `HEARTBEAT.md` existir mas estiver efetivamente vazio (apenas linhas em branco e cabeçalhos
Markdown como `# Heading`), o OpenClaw ignora a execução de heartbeat para economizar chamadas de API.
Se o arquivo estiver ausente, o heartbeat ainda é executado e o modelo decide o que fazer.

Substituições de agente usam `agents.list[].heartbeat`. Documentos: [Heartbeat](/gateway/heartbeat).

### Preciso adicionar uma conta bot a um grupo de WhatsApp

Não. O OpenClaw é executado em **sua própria conta**, então se você estiver no grupo, o OpenClaw poderá vê-lo.
Por padrão, as respostas de grupos são bloqueadas até que você permita remetentes (`groupPolicy: "allowlist"`).

Se você quer apenas **você** para poder acionar respostas em grupo:

```json5
{
  canais: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

### Como faço para obter o JID de um grupo de WhatsApp

Opção 1 (mais rápido): logs de cauda e enviar uma mensagem de teste no grupo:

```bash
openclaw logs --siga --json
```

Procure por `chatId` (ou `from`) terminando em `@g.us`, como:
`1234567890-1234567890@g.us`.

Opção 2 (se já estiver configurado/permitido): lista os grupos da configuração:

```bash
openclaw directory groups list --channel whatsapp
```

Documentos: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

### Porque não responder OpenClaw em um grupo

Duas causas comuns:

- Ponte da menção está ativado (padrão). Você deve @mencionar o bot (ou corresponder a `mentionPatterns`).
- Você configurou o arquivo `channels.whatsapp.groups` sem `"*"` e o grupo não é permitido.

Ver [Groups](/channels/groups) e [Mensagens de grupos](/channels/group-messages).

### Fazer threads compartilham o contexto com mensagens diretas

O colapso das conversas diretas para a sessão principal por padrão. Grupos/canais têm suas próprias chaves de sessão, e tópicos do Telegram / tópicos do Discord são sessões separadas. Ver [Groups](/channels/groups) e [Mensagens de grupos](/channels/group-messages).

### Quantos espaços de trabalho e agentes eu posso criar

Sem limites rígidos. Dezenas (até centenas) estão bem, mas veja por:

- **Crescimento do disco:** sessões + transcrições vivem em `~/.openclaw/agents/<agentId>/sessions/`.
- **Custo de token:** mais agentes significa mais uso simultâneo dos modelos.
- **Ops em excesso:** perfis de autenticação por agente, espaços de trabalho e roteamento de canais.

Dicas:

- Mantenha um espaço de trabalho **ativo** por agente (`agents.defaults.workspace`).
- Apagar sessões antigas (exclua JSONL ou armazene entradas) se o disco crescer.
- Use o `médico do openclaw` para identificar espaços de trabalho perdidos e incompatibilidades de perfil.

### Posso executar vários bots ou chats ao mesmo tempo Slack e como devo configurar isso

Sim. Use **Multi-Agent Routing** para executar vários agentes isolados e rotear mensagens de entrada por
channel/account/peer. O Slack é suportado como um canal e pode ser vinculado a agentes específicos.

O acesso ao navegador é poderoso, mas não "faça nada que seja canho" - antibot, CAPTCHAs e MFA ainda podem
bloquear a automação. Para o controle mais confiável do navegador, use o relé de extensão do Chrome
na máquina que executa o navegador (e mantenha o Gateway em qualquer lugar).

Configuração prática melhor:

- Host do Gateway sempre ligado (VPS/Mac mini).
- Um agente por papel (vinculações).
- Canal(ais) do Slack vinculados a estes agentes.
- Navegador local via retransmissão de extensão (ou um nó) quando necessário.

Documentos: [Multi-Agent Routing](/concepts/multi-agent), [Slack](/channels/slack),
[Browser](/tools/browser), [Chrome extension](/tools/chrome-extension), [Nodes](/nodes).

## Modelos: padrões, seleção, alias, troca

### Qual é o modelo padrão

O modelo padrão do OpenClaw's é o que você definir como:

```
agents.defaults.model.primary
```

Modelos são referenciados como `provider/model` (exemplo: `anthropic/claude-opus-4-6`). Se você omitir o provedor, o OpenClaw atualmente assume `anthropic` como um fallback temporário - mas você ainda deve **explicitamente** definir `provider/model`.

### Que modelo você recomenda

**Padrão recomendado:** `anthropic/claude-opus-4-6`.
**Boa alternativa:** `anthropic/claude-sonnet-4-5`.
**Confiável (menos caractere):** `aberto/gpt-5.2` - quase tão bom quanto Opus, e menos personalidade.
**Budget:** `zai/glm-4.7`.

MiniMax M2.1 tem seus próprios documentos: [MiniMax](/providers/minimax) e
[Modelos locais](/gateway/local-models).

Regra de polegar: use o **melhor modelo que você pode pagar** para um trabalho de alto risco e um modelo
mais barato para bate-papo ou resumos de rotina. Você pode rotear modelos por agente e usar subagentes para
paralelizar tarefas longas (cada sub-agente consome tokens). Ver [Models](/concepts/models) e
[Sub-agents](/tools/subagents).

Aviso forte: Modelos fracos/excessivamente quantificados são mais vulneráveis ao prompt
de injeção e comportamento inseguro. Ver [Security](/gateway/security).

Mais contexto: [Models](/concepts/models).

### Posso usar modelos auto-hospedados llamacpp vLLM Ollama

Sim. Se o seu servidor local expõe uma API compatível com OpenAI, você pode apontar um provedor personalizado
nela. Ollama é suportada diretamente e é o caminho mais fácil.

Nota de segurança: modelos menores ou fortemente quantificados são mais vulneráveis ao prompt
injection. Recomendamos fortemente **modelos grandes** para qualquer bot que possa usar ferramentas.
Se você ainda quiser pequenos modelos, ative a área restrita e ferramentas restritas para listas.

Documentos: [Ollama](/providers/ollama), [Modelos locais](/gateway/local-models),
[Provedores de Modelo](/concepts/model-providers), [Security](/gateway/security),
[Sandboxing](/gateway/sandboxing).

### Como faço para alternar modelos sem limpar minha configuração

Use \*\*comandos model \*\* ou edite apenas os campos **model**. Evite substituições completas de configuração.

Opções seguras:

- `/model` no chat (rápido, por sessão)
- `openclaw models set ...` (atualiza apenas configuração do modelo)
- `openclaw configure --section model` (interativo)
- edite `agents.defaults.model` em `~/.openclaw/openclaw.json`

Evite `config.apply` com um objeto parcial a menos que você pretenda substituir a configuração inteira.
Se você sobrescreveu a configuração, restaure do backup ou execute novamente o `openclaw doctor` para o reparo.

Documentos: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

### O que usar OpenClaw, Flawe Krill para modelos

- **OpenClaw + Flawd:** Opus antrópico (`anthropic/claude-opus-4-6`) - ver [Anthropic](/providers/anthropic).
- **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) - see [MiniMax](/providers/minimax).

### Como faço para alternar os modelos na mosca sem reiniciar

Use o comando `/model` como uma mensagem autônoma:

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

Você pode listar modelos disponíveis com `/model`, `/model list`, ou `/model status`.

`/model` (e `/model list`) mostra um seletor compacto, numerado. Selecionar por número:

```
/modelo 3
```

Você também pode forçar um perfil de autenticação específico para o provedor (por sessão):

```
/model opus@anthropic:default
/model opus@anthropic:work
```

Dica: `/model status` mostra qual agente está ativo, qual arquivo `auth-profiles.json` está sendo usado e qual perfil de autenticação será tentado em seguida.
Ele também mostra o ponto de extremidade do provedor configurado (`baseUrl`) e modo API (`api`) quando disponível.

**Como faço para desafixar um perfil que defino com perfil**

Reexecute `/model` **sem** o sufixo `@profile`:

```
/model anthropic/claude-opus-4-6
```

Se você quer retornar para o padrão, selecione-o de `/model` (ou envie `/model <default provider/model>`).
Use `/model status` para confirmar qual perfil de autenticação está ativo.

### Posso usar GPT 5.2 para tarefas diárias e Codex 5.3 para codificação

Sim. Definir um como padrão e alternar conforme necessário:

- **Interruptor rápido (por sessão):** `/model gpt-5.2` para tarefas diárias, `/model gpt-5.3-codex` para codificação.
- **Padrão + interrupção:** configure `agents.defaults.model.primary` para `openai/gpt-5.2`, então mude para `openai-codex/gpt-5.3-codex` quando programar (ou para o outro lugar).
- **Subagentes:** rotear tarefas de codificação para subagentes com um modelo padrão diferente.

Ver [Models](/concepts/models) e [Comandos do Slash](/tools/slash-commands).

### Por que eu vejo modelo não é permitido e então não há resposta

If `agents.defaults.models` is set, it becomes the **allowlist** for `/model` and any
session overrides. Escolhendo um modelo que não está nessa lista retorna:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Esse erro retornou **ao invés de** uma resposta normal. Corrigir: adicione o modelo a
`agents.defaults.models`, remova a lista ou escolha um modelo da lista `/model `.

### Por que eu vejo um modelo desconhecido minimaxMiniMaxM21

Isso significa que o **provedor não está configurado** (sem configuração de provedor de miniMax ou autenticação
perfil foi encontrado), então o modelo não pode ser resolvido. Uma correção para esta detecção é
em **2026.1.12** (deslançado no momento da escrita).

Corrigir checklist:

1. Atualize para **2026.1.12** (ou execute a partir da origem `main`), depois reinicie o gateway.
2. Certifique-se de que o MiniMax está configurado (assistente ou JSON), ou que uma tecla de API MiniMax
   existe nos perfis env/auth para que o provedor possa ser injetado.
3. Use o modelo exato (sensível a maiúsculas): `minimax/MiniMax-M2.1` ou
   `minimax/MiniMax-M2.1-lightning`.
4. Run:

   ```bash
   openclaw models list
   ```

   e escolha da lista (ou `/model list` no chat).

Ver [MiniMax](/providers/minimax) e [Models](/concepts/models).

### Posso usar o MiniMax como meu padrão e OpenAI para tarefas complexas

Sim. Use **MiniMax como o padrão** e mude modelos **por sessão** quando necessário.
As backbacks são para **erros**, não para "tarefas difíceis", então use `/model` ou um agente separado.

**Opção A: mudar por sessão**

```json5
{
  env: { MINIMAX_API_KEY: "sk-...", OPENAI_API_KEY: "sk-... },
  agentes: {
    defaults: {
      model: { primary: "minimax/MiniMax-M2. " },
      models: {
        "minimax/MiniMax-M2. ": { alias: "minimax" },
        "openai/gpt-5. ": { alias: "gpt" },
      },
    },
  },
}
```

Depois:

```
/model pt
```

**Opção B: agentes separados**

- Agente A default: MiniMax
- Agente B padrão: OpenAI
- Rota pelo agente ou use `/agent` para alternar

Documentos: [Models](/concepts/models), [Multi-Agent Routing](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### Opus sonnet gpt embutido atalhos

Sim. O OpenClaw cria algumas abreviações padrão (aplicadas somente quando o modelo existe em `agents.defaults.models`):

- `opus` → `anthropic/claude-opus-4-6`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

Se você definir seu próprio alias com o mesmo nome, seu valor vence.

### Como definir os apelidos de atalhos do modelo

Aliases come from `agents.defaults.models.<modelId>.alias`. Exemplo:

```json5
{
  agentes: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "anthropic/claude-sonnet-4-5": { alias: "sonnet" },
        "anthropic/claude-haiku-4-5": { alias: "haiku" },
      },
    },
  },
}
```

Então `/model sonnet` (ou `/<alias>` quando suportado) resolve o ID do modelo.

### Como eu adiciono modelos de outros provedores como OpenRouter ou ZAI

OpenRouter (pay-per-token; muitos modelos):

```json5
{
  agentes: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
      models: { "openrouter/anthropic/claude-sonnet-4-5": {} },
    },
  },
  env: { OPENROUTER_API_KEY: "sk-or-. ." },
}
```

Z.AI (modelos GLM):

```json5
{
  agentes: {
    defaults: {
      model: { primary: "zai/glm-4. " },
      models: { "zai/glm-4. ": {} },
    },
  },
  env: { ZAI_API_KEY: "..." },
}
```

Se fizer referência a um provedor/modelo mas a chave de provedor necessária está faltando, você receberá um erro de autenticação em tempo de execução (e. . `Nenhuma chave de API encontrada para o provedor "zai"`).

**Nenhuma chave de API encontrada para o fornecedor após adicionar um novo agente**

Isso geralmente significa que o **novo agente** tem uma loja de autenticação vazia. Autenticação é por agente e
armazenada em:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Opções de correção:

- Execute `openclaw agents add <id>` e configure a autentificação durante o assistente.
- Ou copie o arquivo `auth-profiles.json` do agente principal no `agentDir` do novo agente no `agentDir` do novo agente.

**Não** reutilize o `agentDir` entre agents; isso causa colisões auth/session .

## Falha no modelo e "Todos os modelos falharam"

### Como funciona a falha

Falha ocorre em duas etapas:

1. **Rotação de perfil de autenticação** dentro do mesmo provedor.
2. **Fallback de modelo** para o próximo modelo em `agents.defaults.model.fallbacks`.

Cooldowns se aplicam a perfis falhados (retorno exponencial), então a OpenClaw pode continuar a responder mesmo quando um provedor está limitado pela taxa ou temporariamente falhando.

### O que significa este erro

```
Nenhuma credencial encontrada para o perfil "anthropic:default"
```

Isso significa que o sistema tentou usar o ID do perfil de autenticação `anthropic:default`, mas não pôde encontrar credenciais para ele na loja de autenticação esperada.

### Corrigir checklist para nenhuma credencial encontrada para o anthropicdefault de perfil

- **Confirme onde vivem os perfis de autenticação** (novos vs. caminhos legados)
  - Atual: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - Legado: `~/.openclaw/agent/*` (mignado pelo `médico openclaw`)
- **Confirme se sua var de env está carregada pelo Gateway**
  - Se você definir `ANTHROPIC_API_KEY` em seu projétil, mas executar o Gateway via systemd/launchd, ele não pode herdá-lo. Coloque em `~/.openclaw/.env` ou ative `env.shellEnv`.
- **Certifique-se de que você está editando o agente correto**
  - Configurações de multiagentes significam que pode haver vários arquivos `auth-profiles.json`.
- **Estado do modelo/auth Sanity-check**
  - Use o `status de modelos openclaw` para ver os modelos configurados e se provedores são autenticados.

**Corrigir checklist para nenhuma credencial encontrada para a antropia de perfil**

Isso significa que a execução está fixada em um perfil de autenticação Antrópico, mas o Gateway
não conseguiu encontrá-lo em sua loja de autenticação.

- **Use um token de configuração**
  - Execute `claude setup-token`, então cole-o com `openclaw models auth setup-token --provider anthropic`.
  - Se o token foi criado em outra máquina, use `openclaw models auth paste-token --provider anthropic`.

- **Se você quiser usar uma chave de API em vez disso**
  - Coloque `ANTHROPIC_API_KEY` em `~/.openclaw/.env` no **host de gateway**.
  - Limpa qualquer ordem fixada que força um perfil faltante:

    ```bash
    openclaw models auth order clear - provedor antrópico
    ```

- **Confirme que você está executando comandos no host de gateway**
  - Em modo remoto, perfis de autenticação vivem na máquina de entrada, não no seu laptop.

### Por que também experimentou o Google Gemini e falhou

Se a sua configuração do modelo inclui o Google Gemini como um recurso (ou você trocou para um atalho no Gemini), o OpenClaw vai tentar durante o recurso do modelo. Se você não configurou as credenciais do Google, você verá `Nenhuma chave API encontrada para o provedor "google"`.

Corrigir: ou fornecer Google auth, ou remover/evitar Google models em `agents.defaults.model.fallbacks` / aliases para que o fallback não faça roteamento.

**Solicitação LLM rejeitou a assinatura do raciocínio de mensagem requerida pelo google antigravity**

Causa: o histórico de sessão contém **blocos de pensamento sem assinaturas** (muitas vezes de
um fluxo abortado/parcial). O Google Antigravity requer assinaturas para blocos de pensamento.

Correção: OpenClaw agora remove blocos de pensamento não assinados para a Cláusula Google Antigravity. Se ainda aparecer, inicie uma **nova sessão** ou defina `/thinking off` para esse agente.

## Perfis de autenticação: o que são e como gerenciá-los

Relacionado: [/concepts/oauth](/concepts/oauth) (OAuth fluxos, armazenamento token, padrões multi-conta)

### O que é um perfil de autenticação

Um perfil de autenticação é um registro de credenciais nomeado (OAuth ou chave de API) vinculada a um provedor. Perfis ao vivo em:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### Quais são IDs de perfil típicos

OpenClaw usa IDs prefixados por provedor:

- `anthropic:default` (comum quando nenhuma identidade de e-mail existe)
- `anthropic:<email>` para identidades OAuth
- IDs personalizados que você escolher (por exemplo, `anthropic:work`)

### Eu posso controlar qual perfil de autenticação está tentando primeiro

Sim. A configuração suporta metadados opcionais para perfis e uma ordem por provedor (`auth.order.<provider>`). Isto **não** armazena segredos; ele mapeia os IDs para provedor/modo e define a ordem de rotação.

O OpenClaw pode pular temporariamente um perfil se estiver em um curto **tempo de recarga** (limites de taxa/falhas de autenticação) ou um estado mais longo **desativado** (faturação/insuficiente créditos). Para inspecionar isso, execute `openclaw models status --json` e verifique `auth.unusableProfiles`. Sintonização: `auth.cooldowns.billingBackoffHours*`.

Você também pode definir uma substituição de pedido **por agente** (armazenado no `auth-profiles.json` desse agente através do CLI:

```bash
# Padrões para o agente padrão configurado (omit --agent)
openclaw models auth order get --provider anthropic

# Lock rotation to a um único perfil (somente tente este)
openclaw models auth order set --provider anthropic:default

# Or set uma ordem explícita (fallback dentro do provedor)
openclaw models auth order --provider anthropic:work anthropic:work anthropic:default

# Clear override (fall to config auth. rder / round-robin)
ordem de autenticação dos modelos openclaw limpo - provedor antrópico
```

Para escolher um agente específico:

```bash
openclaw models auth order set --provider anthropic --agent main anthropic:default
```

### OAuth vs chave API qual é a diferença

OpenClaw suporta ambos:

- **OAuth** muitas vezes utiliza o acesso à assinatura (quando aplicável).
- **Chaves API** usam faturamento pay-por-token.

O assistente suporta explicitamente o token de configuração Antrópica e o OpenAI Codex OAuth e pode armazenar as chaves da API para você.

## Gateway: portas, "já em execução" e modo remoto

### Qual porta usa o Gateway

`gateway.port` controla a porta multiplexada única para WebSocket + HTTP (Control UI, hooks, etc.).

Precedência:

```
--port > OPENCLAW_GATEWAY_PORT > gateway.port > padrão 18789
```

### Por que o status do gateway openclaw diz Runtime executando mas RPC probe falhou

Porque "Executando" é a visão **do supervisor** (iniciar/systemd/schtasks). A sonda RPC é o CLI realmente se conectando com o gateway WebSocket e chamando `status`.

Use `status do gateway openclaw` e confie nestas linhas:

- `Probe target:` (o URL a sonda realmente usada)
- `Ouvindo:` (o que realmente está ligado na porta)
- `Último erro do gateway:` (causa comum da raiz quando o processo está vivo, mas a porta não está escutando)

### Por que o status do gateway openclaw mostra a configuração cli e o serviço de configuração diferentes

Você está editando um arquivo de configuração enquanto o serviço está executando outro (muitas vezes uma incompatibilidade `--profile` / `OPENCLAW_STATE_DIR`).

Correção:

```bash
openclaw gateway install --force
```

Execute isso no mesmo `--profile` / ambiente que você deseja que o serviço use.

### O que outra instância do gateway é já escutar a média

OpenClaw impõe um bloqueio de tempo de execução vinculando o ouvinte de WebSocket imediatamente ao iniciar (padrão `ws://127.0.0.1:18789`). Se a conexão falhar com `EADDRINUSE`, ele lança `GatewayLockError` indicando que outra instância já está escutando.

Corrigir: pare a outra instância, libere a porta ou execute com `openclaw gateway --port <port>`.

### Como eu rodo o OpenClaw no modo remoto que o cliente conecta a um Gateway em outro lugar

Defina `gateway.mode: "remote"` e aponte para uma URL remota de WebSocket, opcionalmente com um token/password:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      password: "your-password",
    },
  },
}
```

Notes:

- `openclaw gateway` começa somente quando `gateway.mode` é `local` (ou você passa a bandeira de substituição).
- O app macOS assiste o arquivo de configuração e troca os modos de configuração ao vivo quando esses valores forem alterados.

### A UI Controle diz não autorizado ou continua reconectando o que agora

Seu gateway está rodando com autenticação habilitada (`gateway.auth.*`), mas a interface do usuário não está enviando o token correspondente/senha.

Fatos (do código):

- A UI Control armazena o token no navegador localStorage key `openclaw.control.settings.v1`.

Correção:

- Mais rápido: `openclaw dashboard` (imprime + copia o URL do painel, tenta abrir; mostra hint de SSH, se nada for assim).
- Se você ainda não tem um token: `openclaw doctor --generate-gateway-token`.
- Se remoto, o túnel primeiro: `ssh -N -L 18789:127.0.0.1:18789 user@host` então abra `http://127.0.0.1:18789/`.
- Defina `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`) no host de gateway.
- Nas configurações da UI de controle, cole o mesmo token.
- Ainda está travado? Execute `openclaw status --all` e siga [Troubleshooting](/gateway/troubleshooting). Ver [Dashboard](/web/dashboard) para detalhes de autenticação.

### Eu defino gatewaybind tailnet mas não pode vincular nada

`tailnet` bind escolhe um IP Tailscale de suas interfaces de rede (100.64.0.0/10). Se a máquina não estiver em escala Caudal (ou a interface estiver descida), não há nada ao qual ser vinculada.

Correção:

- Comece a escala Caudal naquele host (para que ele tenha um endereço 100.x), ou
- Alterne para `gateway.bind: "loopback"` / `"lan"`.

Nota: `tailnet` é explícito. `auto` prefere loop; use `gateway.bind: "tailnet"` quando você quer uma tailnet-only bind.

### Posso executar vários Gateways no mesmo host

Geralmente não - um Gateway pode executar vários canais e agentes de mensagens. Use vários Gateways somente quando você precisa de redundância (ex: bot de resgate) ou isolamento rígido.

Sim, mas você deve isolar:

- `OPENCLAW_CONFIG_PATH` (per-instance config)
- `OPENCLAW_STATE_DIR` (estado por instância)
- `agents.defaults.workspace` (isolamento do espaço de trabalho)
- `gateway.port` (portas únicas)

Configuração rápida (recomendado):

- Use `openclaw --profile <name> …` por instância (auto-cria `~/.openclaw-<name>`).
- Defina um `gateway.port` único em cada configuração do perfil (ou passe `--port` para execução manual).
- Install a per-profile service: `openclaw --profile <name> gateway install`.

Perfis também sufixo nomes de serviço (`bot.molt.<profile>`; Legado `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`).
Guia completo: [Múltiplos gateways](/gateway/multiple-gateways).

### O que significa o código de handshake inválido 1008

The Gateway is a **WebSocket server**, and it expects the very first message to
be a `connect` frame. Se receber qualquer outra coisa, fecha a conexão
com o **código 1008** (violação de política).

Causas comuns:

- Você abriu o URL **HTTP** em um navegador (`http://...`) em vez de um cliente WS.
- Você usou a porta ou caminho errado.
- Um proxy ou túnel desceu os cabeçalhos de autenticação ou enviou uma solicitação que não é do Gateway.

Correções rápidas:

1. Utilize a URL do WS: `ws://<host>:18789` (ou `wss://...` se HTTPS).
2. Não abra a porta do WS em uma guia normal do navegador.
3. Se a autenticação estiver ativada, inclua o token/password no quadro `connect`.

Se você estiver usando o CLI ou TUI, a URL deve se parecer com:

```
openclaw tui --url ws://<host>:18789 --token <token>
```

Detalhes do protocolo: [Gateway protocol](/gateway/protocol).

## Registro e depuração

### Onde estão os registros

Logs de arquivos (estruturados):

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Você pode definir um caminho estável através de `logging.file`. Nível de log do arquivo é controlado por `logging.level`. Verbosidade do console é controlada por `--verbose` and `logging.consoleLevel`.

Cauda de registro mais rápida:

```bash
openclaw logs --follow
```

Logs de serviço/supervisor (quando o gateway é executado via iniciar/sistema):

- macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` e `gateway.err.log` (padrão: `~/.openclaw/logs/...`; perfis usam `~/.openclaw-<profile>/logs/...`)
- Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

Ver [Troubleshooting](/gateway/troubleshooting#log-locations) para mais.

### Como eu inicio reiniciar o serviço do Gateway

Use os auxiliares do gateway:

```bash
status do gateway openclaw
Reinício do gateway openclaw
```

Se você executar o gateway manualmente, `openclaw gateway --force` pode recuperar a porta. Veja [Gateway](/gateway).

### Fechei meu terminal no Windows como reiniciar o OpenClaw

Existem **dois modos de instalação no Windows**:

**1) WSL2 (recomendado):** o Gateway roda dentro do Linux.

Abra PowerShell, insira o WSL, e então reinicie:

```powershell
wsl
Status do gateway openclaw
Reinício do gateway openclaw
```

Se você nunca instalou o serviço, inicie-o em primeiro plano:

```bash
openclaw gateway run
```

**2) Windows Nativo (não recomendado):** O Gateway é executado diretamente no Windows.

Abra PowerShell e execute:

```powershell
status do gateway openclaw
Reinício do gateway openclaw
```

Se você executá-lo manualmente (sem serviço), use:

```powershell
openclaw gateway run
```

Documentos: [Windows (WSL2)](/platforms/windows), [Gateway service runbook](/gateway).

### O Gateway está certo, mas as respostas nunca chegam ao que devo verificar

Comece com uma varredura rápida de saúde:

```bash
openclaw status
openclaw status
de canais openclaw status
logs do openclaw --follow
```

Causas comuns:

- Autorização do modelo não carregada no **host de gateway** (veja `status dos modelos`).
- Pareamento/Permitir lista de bloqueando respostas (verifique a configuração do canal + logs).
- WebChat/Dashboard está aberto sem o token correto.

Se você é remoto, confirme que a conexão de Túnel/Escala Caudal está ativa e que o
WebSocket de Gateway está acessível.

Documentos: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Acesso remoto](/gateway/remote).

### Desconectado do gateway não há razão para o quê agora

Isso geralmente significa que a interface do usuário perdeu a conexão de WebSocket. Verifique:

1. O Gateway está correndo? `openclaw gateway status`
2. O Gateway está saudável? `openclaw status`
3. A interface do usuário tem o token correto? `openclaw dashboard`
4. Se remoto, a ligação ao túnel/Escala Caudal será maior?

Então registros de cauda:

```bash
openclaw logs --follow
```

Documentos: [Dashboard](/web/dashboard), [Acesso remoto](/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

### Telegram setMyCommands falhou com erros de rede o que devo verificar

Iniciar com logs e status do canal:

```bash
canal de openclaw status
openclaw logs --channel telegram
```

Se você estiver em um VPS ou por trás de um proxy, confirme que o HTTPS de saída é permitido e que o DNS funciona.
Se o Gateway é remoto, certifique-se de estar olhando para os logs no Host do Gateway.

Documentos: [Telegram](/channels/telegram), [Canal de solução de problemas](/channels/troubleshooting).

### A TUI não mostra saída o que devo verificar

Primeiro confirme o Gateway é acessível e o agente pode executar:

```bash
openclaw status
openclaw status
registros openclaw --follow
```

Na TUI, use `/status` para ver o estado atual. Se você espera respostas em um canal
no chat, certifique-se de que a entrega esteja habilitada (`/deliver on`).

Documentos: [TUI](/web/tui), [Slash commands](/tools/slash-commands).

### Como eu pareço completamente e inicio o Gateway

Se você instalou o serviço:

```bash
openclaw gateway para
inicação no gateway openclaw
```

Isto para/inicia o **serviço supervisionado** (launchd on macOS, systemd on Linux).
Use isso quando o Gateway é executado em segundo plano como um daemon.

Se você está correndo em primeiro plano, pare com Ctrl-C, então:

```bash
openclaw gateway run
```

Docs: [Gateway service runbook](/gateway).

### ELI5 gateway openclaw reinicializa contra o gateway openclaw

- `Reinício do gateway openclaw`: reinicia o **serviço em segundo plano** (iniciar/sistema).
- `gateway openclaw`: executa o gateway **em primeiro plano** para esta sessão terminal.

Se você instalou o serviço, use os comandos de gateway. Use `gateway openclaw` quando
você quer uma entrada única, em primeiro plano.

### Qual é a maneira mais rápida de obter mais detalhes quando algo falha

Inicie o Gateway com `--verbose` para obter mais detalhes do console. Em seguida, inspecione o arquivo de log da autenticação de canal, roteamento modelo e erros de RPC.

## Mídia e anexos

### Minha habilidade gerou uma imagemPDF mas nada foi enviado

Anexos de saída do agente deve incluir uma linha `MEDIA:<path-or-url>` (em sua própria linha). Veja [OpenClaw assistente setup](/start/openclaw) e [Agent send](/tools/agent-send).

Envio de CLI:

```bash
openclaw message send --target +15555550123 --message "Aqui está" --media /caminho/para/arquivo.png
```

Também verifique:

- O canal alvo suporta mídia de saída e não é bloqueado por listas de permissões.
- O arquivo está dentro dos limites de tamanho do provedor (imagens são redimensionadas para o máximo de 2048px).

Ver [Images](/nodes/images).

## Controle de segurança e acesso

### É seguro expor OpenClaw a mensagens diretas de entrada

Tratar DMs de entrada como entrada não confiável. Os padrões são projetados para reduzir o risco:

- Comportamento padrão em canais que rodam DMS é **emparelhando**:
  - Remetentes desconhecidos recebem um código de pareamento; o bot não processa sua mensagem.
  - Approve with: `openclaw pairing approve <channel> <code>`
  - Pedidos pendentes são limitados em **3 por canal**; verifique `a lista de emparelhamento do openclaw <channel>` se o código não chegar.
- Abrir DMs publicamente requer opt-in explícito (`dmPolicy: "open"` e allowlist `"*"`).

Execute o `openclaw doctor` para desenvolver políticas DM arriscadas.

### O prompt de injeção é apenas uma preocupação para bots públicos

Não. Injeção imediata é sobre **conteúdo não confiável**, e não apenas quem pode MD o bot.
Se seu assistente ler conteúdo externo (busca/busca da web, páginas do navegador, e-mails,
docs, anexos, logs colados), que conteúdo pode incluir instruções que tentem
para sequestrar o modelo. Isso pode acontecer mesmo que **você seja o único remetente**.

O maior risco é quando as ferramentas estão habilitadas: o modelo pode ser enganado no contexto de exfiltração
ou nas ferramentas de chamada em seu nome. Reduza o raio de impacto ao:

- usando apenas leitura ou agente "leitor" desativado pela ferramenta para resumir conteúdo não confiável
- mantendo `web_search` / `web_fetch` / `browser` desligado para agentes habilitados com ferramentas
- sandboxing e estrita lista de permissões da ferramenta

Detalhes: [Security](/gateway/security).

### Se meu bot tiver sua própria conta de e-mail do GitHub ou número de telefone

Sim, para a maioria das configurações. Isolar o bot com contas separadas e números de telefone
reduz o raio explosivo se algo der errado. Isso também torna mais fácil girar
credenciais ou revogar acesso sem afetar suas contas pessoais.

Comece pequeno. Give access only to the tools and accounts you actually need, and expand
later if required.

Documentos: [Security](/gateway/security), [Pairing](/channels/pairing).

### Posso dar-lhe autonomia sobre as minhas mensagens de texto e é muito seguro

Nós **não** recomendamos autonomia total sobre suas mensagens pessoais. O padrão mais seguro é:

- Mantenha DMs no **modo de emparelhamento** ou uma lista apertada de permissões.
- Use um **número ou conta separada** se você quiser que envie uma mensagem em seu nome.
- Deixe este rascunho, depois **aprove antes de enviar**.

Se você quiser experimentar, faça isso em uma conta dedicada e mantenha-o isolado. Veja
[Security](/gateway/security).

### Posso usar modelos mais baratos para tarefas pessoais de assistente

Sim, **se** o agente é somente chat e o valor de entrada é confiável. Níveis menores são
mais suscetíveis a sequestro de instruções, então evite-os para agentes habilitados com ferramentas
ou quando ler conteúdo não confiável. Se você deve usar um modelo menor, trave
ferramentas e rode dentro de uma caixa de areia. Ver [Security](/gateway/security).

### Eu executei no Telegram mas não consegui um código de pareamento

Códigos de pareamento são enviados **somente** quando um remetente desconhecido envia mensagens para o bot e
`dmPolicy: "pareando"` está habilitado. `/start` por si só não gera um código.

Verificar solicitações pendentes:

```bash
openclaw pairing list telegram
```

Se você quer acesso imediato, permite sua ajuda ao remetente ou defina `dmPolicy: "open"`
para essa conta.

### O WhatsApp irá enviar mensagens para os meus contatos Como o pareamento funciona

Não. A política padrão do WhatsApp DM é de **emparelhar**. Remetentes desconhecidos recebem apenas um código de emparelhamento e sua mensagem **não foi processado**. OpenClaw apenas respostas para bate-papos que recebe ou para explicitamente enviar seu gatilho.

Aprovar emparelhamento com:

```bash
openclaw pairing approve whatsapp <code>
```

Listar solicitações pendentes:

```bash
openclaw pairing list whatsapp
```

Solicitação de número de telefone do assistente: ela é usada para definir seu **allowlist/owner** para que suas próprias mensagens sejam permitidas. Não é usado para envio automático. Se você executar no seu número pessoal do WhatsApp, use esse número e habilite `channels.whatsapp.selfChatMode`.

## Comandos de bate-papo, tarefas canceladas e "isto não vai parar"

### Como faço para impedir que as mensagens internas do sistema sejam exibidas no bate-papo

A maioria das mensagens internas ou de ferramentas só aparecem quando o **verbose** ou o **raciocínio** está ativado
nessa sessão.

Corrija no chat onde você o vê:

```
/verbose off
/reasoning off
```

Se ele ainda estiver barulhento, verifique as configurações de sessão na UI de controle e defina a verbose
para **herdar**. Também confirme que você não está usando um perfil bot com `verboseDefault` definir
para `on` na configuração.

Documentos: [Pensando e verbose](/tools/thinking), [Security](/gateway/security#reasoning--verbose-output-in-groups).

### Como paro de cancelar uma tarefa

Envie qualquer um desses **como uma mensagem autônoma** (sem barra):

```
parar
cancelar
esc
esperar
exit
interromper
```

Estes são acionados por abortos (não são comandos com cortes).

Para processos em segundo plano (a partir da ferramenta Exec), você pode pedir ao agente que execute:

```
ação de processo:kill sessionId:XXX
```

Visão geral dos comandos do Slash: veja [comandos do Slash](/tools/slash-commands).

A maioria dos comandos deve ser enviada como uma mensagem **standalone** que começa com `/`, mas alguns atalhos (como `/status`) também funcionam em linha para remetentes permitidos.

### Como enviar uma mensagem do Discord de mensagens de Crosscontext do Telegram negadas

Blocos do OpenClaw por padrão **cross-provider**. Se uma chamada com ferramentas estiver vinculada a
ao Telegram, isso não enviará para o Discord a menos que você permita explicitamente isso.

Ativar mensagens entre provedores para o agente:

```json5
{
  agents: {
    defaults: {
      tools: {
        message: {
          crossContext: {
            allowAcrossProviders: true,
            marcador: { enabled: true, prefixo: "[de {channel}] " },
          },
        },
      },
    },
  },
}
```

Reinicie o gateway depois de editar a configuração. Se você só quiser isso para um único agente
, coloque-o em `agents.list[].tools.message`.

### Por que parece que o bot ignora mensagens de fogo rápidas

O modo de fila controla como as novas mensagens interagem com uma execução em voo. Use `/queue` para mudar os modos:

- `steer` - novas mensagens redirecionam a tarefa atual
- `followup` - executa mensagens uma de cada vez
- `coletar` - mensagens em lote e responder uma vez (padrão)
- `steer-backlog` - dirigir agora, e depois processar o backlog
- `interrupt` - abortar a execução atual e começar de novo

Você pode adicionar opções como `debounce:2s cap:25 drop:summarize` para modos de acompanhamento.

## Responda à pergunta exata da captura de tela/registro de bate-papo

**P: "Qual é o modelo padrão para Anthropic com uma chave de API?"**

**R:** Em OpenClaw, credenciais e seleção de modelo são separadas. Definir `ANTHROPIC_API_KEY` (ou armazenar uma chave de API Anthropic nos perfis de autenticação) permite a autenticação, mas o modelo padrão é tudo o que você configurar em 'agentes'. efaults.model.primary`(por exemplo,`anthropic/claude-sonnet-4-5`ou`anthropic/claude-opus-4-6`). Se você ver `Nenhuma credencial encontrada para o perfil "anthropic:default"`, significa que o Gateway não pôde encontrar credenciais Antrópicas nos `perfil-autor/esperados. filho\` para o agente que está correndo.

---

Ainda está travado? Pergunte no [Discord](https://discord.com/invite/clawd) ou abra uma [discussão no GitHub](https://github.com/openclaw/openclaw/discussions).
