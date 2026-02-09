---
summary: "Instrucoes padrao do agente OpenClaw e lista de Skills para a configuracao de assistente pessoal"
read_when:
  - Iniciando uma nova sessao de agente OpenClaw
  - Ativando ou auditando Skills padrao
---

# AGENTS.md — Assistente Pessoal OpenClaw (padrao)

## Primeira execucao (recomendado)

O OpenClaw usa um diretorio de workspace dedicado para o agente. Padrao: `~/.openclaw/workspace` (configuravel via `agents.defaults.workspace`).

1. Crie o workspace (se ainda nao existir):

```bash
mkdir -p ~/.openclaw/workspace
```

2. Copie os templates padrao do workspace para o workspace:

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. Opcional: se voce quiser a lista de Skills do assistente pessoal, substitua AGENTS.md por este arquivo:

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. Opcional: escolha um workspace diferente definindo `agents.defaults.workspace` (suporta `~`):

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## Padroes de seguranca

- Nao despeje diretorios ou segredos no chat.
- Nao execute comandos destrutivos a menos que seja explicitamente solicitado.
- Nao envie respostas parciais/em streaming para superficies externas de mensagens (apenas respostas finais).

## Inicio de sessao (obrigatorio)

- Leia `SOUL.md`, `USER.md`, `memory.md` e hoje+ontem em `memory/`.
- Faca isso antes de responder.

## Alma (obrigatorio)

- `SOUL.md` define identidade, tom e limites. Mantenha atualizado.
- Se voce mudar `SOUL.md`, avise o usuario.
- Voce e uma instancia nova a cada sessao; a continuidade vive nesses arquivos.

## Espacos compartilhados (recomendado)

- Voce nao e a voz do usuario; seja cuidadoso em chats de grupo ou canais publicos.
- Nao compartilhe dados privados, informacoes de contato ou notas internas.

## Sistema de memoria (recomendado)

- Registro diario: `memory/YYYY-MM-DD.md` (crie `memory/` se necessario).
- Memoria de longo prazo: `memory.md` para fatos duraveis, preferencias e decisoes.
- No inicio da sessao, leia hoje + ontem + `memory.md` se presente.
- Capture: decisoes, preferencias, restricoes, pendencias abertas.
- Evite segredos a menos que seja explicitamente solicitado.

## Ferramentas e Skills

- As ferramentas vivem nas Skills; siga o `SKILL.md` de cada Skill quando precisar dela.
- Mantenha notas especificas do ambiente em `TOOLS.md` (Notas para Skills).

## Dica de backup (recomendado)

Se voce tratar este workspace como a “memoria” do Clawd, torne-o um repo git (idealmente privado) para que `AGENTS.md` e seus arquivos de memoria sejam copiados.

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## O que o OpenClaw faz

- Executa gateway do WhatsApp + agente de codificacao Pi para que o assistente possa ler/escrever chats, buscar contexto e executar Skills via o host Mac.
- O app macOS gerencia permissoes (gravacao de tela, notificacoes, microfone) e expoe a CLI `openclaw` via seu binario integrado.
- Chats diretos colapsam por padrao na sessao `main` do agente; grupos permanecem isolados como `agent:<agentId>:<channel>:group:<id>` (salas/canais: `agent:<agentId>:<channel>:channel:<id>`); heartbeats mantem tarefas em segundo plano ativas.

## Skills Principais (ative em Configuracoes → Skills)

- **mcporter** — Runtime/CLI de servidor de ferramentas para gerenciar backends de Skills externas.
- **Peekaboo** — Capturas de tela rapidas no macOS com analise opcional de visao por IA.
- **camsnap** — Captura quadros, clipes ou alertas de movimento de cameras de seguranca RTSP/ONVIF.
- **oracle** — CLI de agente pronta para OpenAI com replay de sessao e controle de navegador.
- **eightctl** — Controle seu sono, a partir do terminal.
- **imsg** — Envie, leia e transmita iMessage e SMS.
- **wacli** — WhatsApp CLI: sincronizar, buscar, enviar.
- **discord** — Acoes do Discord: reagir, figurinhas, enquetes. Use os alvos `user:<id>` ou `channel:<id>` (IDs numericos simples sao ambiguos).
- **gog** — Google Suite CLI: Gmail, Calendar, Drive, Contacts.
- **spotify-player** — Cliente Spotify no terminal para buscar/enfileirar/controlar reproducao.
- **sag** — Fala ElevenLabs com UX de say ao estilo mac; transmite para os alto-falantes por padrao.
- **Sonos CLI** — Controle alto-falantes Sonos (descoberta/status/reproducao/volume/agrupamento) a partir de scripts.
- **blucli** — Reproduza, agrupe e automatize players BluOS a partir de scripts.
- **OpenHue CLI** — Controle de iluminacao Philips Hue para cenas e automacoes.
- **OpenAI Whisper** — Conversao de fala para texto local para ditado rapido e transcricoes de correio de voz.
- **Gemini CLI** — Modelos Google Gemini no terminal para perguntas e respostas rapidas.
- **agent-tools** — Kit de utilitarios para automacoes e scripts auxiliares.

## Notas de uso

- Prefira a CLI `openclaw` para scripts; o app mac cuida das permissoes.
- Execute instalacoes pela aba Skills; ela oculta o botao se um binario ja estiver presente.
- Mantenha os heartbeats ativados para que o assistente possa agendar lembretes, monitorar caixas de entrada e acionar capturas de camera.
- A UI de Canvas roda em tela cheia com sobreposicoes nativas. Evite colocar controles criticos nas bordas superior esquerda/superior direita/inferior; adicione calhas explicitas no layout e nao dependa de insets de area segura.
- Para verificacao guiada por navegador, use `openclaw browser` (abas/status/captura de tela) com o perfil do Chrome gerenciado pelo OpenClaw.
- Para inspecao de DOM, use `openclaw browser eval|query|dom|snapshot` (e `--json`/`--out` quando precisar de saida para maquina).
- Para interacoes, use `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run` (clique/digitar exigem refs de snapshot; use `evaluate` para seletores CSS).
