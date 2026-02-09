---
summary: "Mensagens de polling de heartbeat e regras de notificação"
read_when:
  - Ajustar a cadência ou as mensagens do heartbeat
  - Decidir entre heartbeat e cron para tarefas agendadas
title: "Heartbeat"
---

# Heartbeat (Gateway)

> **Heartbeat vs Cron?** Veja [Cron vs Heartbeat](/automation/cron-vs-heartbeat) para orientações sobre quando usar cada um.

O Heartbeat executa **turnos periódicos do agente** na sessão principal para que o modelo possa
trazer à tona qualquer coisa que precise de atenção sem enviar spam.

Solução de problemas: [/automation/troubleshooting](/automation/troubleshooting)

## Início rápido (iniciante)

1. Deixe os heartbeats habilitados (o padrão é `30m`, ou `1h` para Anthropic OAuth/setup-token) ou defina sua própria cadência.
2. Crie uma pequena checklist `HEARTBEAT.md` no workspace do agente (opcional, mas recomendado).
3. Decida para onde as mensagens de heartbeat devem ir (`target: "last"` é o padrão).
4. Opcional: habilite a entrega de raciocínio do heartbeat para transparência.
5. Opcional: restrinja os heartbeats a horas ativas (hora local).

Exemplo de configuração:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## Padrões

- Intervalo: `30m` (ou `1h` quando Anthropic OAuth/setup-token é o modo de autenticação detectado). Defina `agents.defaults.heartbeat.every` ou por agente `agents.list[].heartbeat.every`; use `0m` para desabilitar.
- Corpo do prompt (configurável via `agents.defaults.heartbeat.prompt`):
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- O prompt de heartbeat é enviado **verbatim** como a mensagem do usuário. O prompt
  do sistema inclui uma seção “Heartbeat” e a execução é sinalizada internamente.
- Horas ativas (`heartbeat.activeHours`) são verificadas no fuso horário configurado.
  Fora da janela, os heartbeats são ignorados até o próximo tick dentro da janela.

## Para que serve o prompt de heartbeat

O prompt padrão é intencionalmente amplo:

- **Tarefas em segundo plano**: “Consider outstanding tasks” incentiva o agente a revisar
  acompanhamentos (caixa de entrada, calendário, lembretes, trabalho em fila) e trazer à tona qualquer coisa urgente.
- **Check-in humano**: “Checkup sometimes on your human during day time” incentiva uma
  mensagem ocasional e leve de “precisa de algo?”, mas evita spam noturno
  usando seu fuso horário local configurado (veja [/concepts/timezone](/concepts/timezone)).

Se você quiser que um heartbeat faça algo muito específico (por exemplo, “verificar estatísticas do Gmail PubSub”
ou “verificar a saúde do gateway”), defina `agents.defaults.heartbeat.prompt` (ou
`agents.list[].heartbeat.prompt`) para um corpo personalizado (enviado verbatim).

## Contrato de resposta

- Se nada precisar de atenção, responda com **`HEARTBEAT_OK`**.
- Durante execuções de heartbeat, o OpenClaw trata `HEARTBEAT_OK` como um ack quando aparece
  no **início ou no fim** da resposta. O token é removido e a resposta é descartada se o conteúdo restante for **≤ `ackMaxChars`** (padrão: 300).
- Se `HEARTBEAT_OK` aparecer no **meio** de uma resposta, não é tratado
  de forma especial.
- Para alertas, **não** inclua `HEARTBEAT_OK`; retorne apenas o texto do alerta.

Fora de heartbeats, `HEARTBEAT_OK` solto no início/fim de uma mensagem é removido
e registrado; uma mensagem que seja apenas `HEARTBEAT_OK` é descartada.

## Configuração

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### Escopo e precedência

- `agents.defaults.heartbeat` define o comportamento global de heartbeat.
- `agents.list[].heartbeat` mescla por cima; se algum agente tiver um bloco `heartbeat`, **apenas esses agentes** executam heartbeats.
- `channels.defaults.heartbeat` define padrões de visibilidade para todos os canais.
- `channels.<channel>.heartbeat` sobrescreve os padrões do canal.
- `channels.<channel>.accounts.<id>.heartbeat` (canais multi-conta) sobrescreve configurações por canal.

### Heartbeats por agente

Se qualquer entrada `agents.list[]` incluir um bloco `heartbeat`, **apenas esses agentes**
executam heartbeats. O bloco por agente mescla por cima de `agents.defaults.heartbeat`
(então você pode definir padrões compartilhados uma vez e sobrescrever por agente).

Exemplo: dois agentes, apenas o segundo agente executa heartbeats.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### Exemplo de horas ativas

Restrinja heartbeats ao horário comercial em um fuso horário específico:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

Fora dessa janela (antes das 9h ou depois das 22h no Leste), os heartbeats são ignorados. O próximo tick agendado dentro da janela será executado normalmente.

### Exemplo multi-conta

Use `accountId` para direcionar uma conta específica em canais multi-conta como o Telegram:

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678",
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### Notas de campo

- `every`: intervalo do heartbeat (string de duração; unidade padrão = minutos).
- `model`: sobrescrita opcional do modelo para execuções de heartbeat (`provider/model`).
- `includeReasoning`: quando habilitado, também entrega a mensagem separada `Reasoning:` quando disponível (mesmo formato de `/reasoning on`).
- `session`: chave de sessão opcional para execuções de heartbeat.
  - `main` (padrão): sessão principal do agente.
  - Chave de sessão explícita (copie de `openclaw sessions --json` ou da [CLI de sessões](/cli/sessions)).
  - Formatos de chave de sessão: veja [Sessões](/concepts/session) e [Grupos](/channels/groups).
- `target`:
  - `last` (padrão): entrega para o último canal externo usado.
  - canal explícito: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`.
  - `none`: executa o heartbeat, mas **não entrega** externamente.
- `to`: sobrescrita opcional do destinatário (id específico do canal, por exemplo E.164 para WhatsApp ou um chat id do Telegram).
- `accountId`: id de conta opcional para canais multi-conta. Quando `target: "last"`, o id da conta se aplica ao último canal resolvido se ele suportar contas; caso contrário, é ignorado. Se o id da conta não corresponder a uma conta configurada para o canal resolvido, a entrega é ignorada.
- `prompt`: sobrescreve o corpo padrão do prompt (não mescla).
- `ackMaxChars`: máximo de caracteres permitidos após `HEARTBEAT_OK` antes da entrega.
- `activeHours`: restringe execuções de heartbeat a uma janela de tempo. Objeto com `start` (HH:MM, inclusivo), `end` (HH:MM exclusivo; `24:00` permitido para fim de dia) e `timezone` opcional.
  - Omitido ou `"user"`: usa seu `agents.defaults.userTimezone` se definido; caso contrário, recorre ao fuso horário do sistema do host.
  - `"local"`: sempre usa o fuso horário do sistema do host.
  - Qualquer identificador IANA (por exemplo, `America/New_York`): usado diretamente; se inválido, recorre ao comportamento `"user"` acima.
  - Fora da janela ativa, os heartbeats são ignorados até o próximo tick dentro da janela.

## Comportamento de entrega

- Os heartbeats são executados na sessão principal do agente por padrão (`agent:<id>:<mainKey>`),
  ou `global` quando `session.scope = "global"`. Defina `session` para sobrescrever para uma
  sessão de canal específica (Discord/WhatsApp/etc.).
- `session` afeta apenas o contexto de execução; a entrega é controlada por `target` e `to`.
- Para entregar a um canal/destinatário específico, defina `target` + `to`. Com
  `target: "last"`, a entrega usa o último canal externo dessa sessão.
- Se a fila principal estiver ocupada, o heartbeat é ignorado e tentado novamente mais tarde.
- Se `target` resolver para nenhum destino externo, a execução ainda acontece, mas nenhuma
  mensagem de saída é enviada.
- Respostas somente de heartbeat **não** mantêm a sessão ativa; o último `updatedAt`
  é restaurado para que a expiração por inatividade se comporte normalmente.

## Controles de visibilidade

Por padrão, reconhecimentos `HEARTBEAT_OK` são suprimidos enquanto o conteúdo de alerta é
entregue. Você pode ajustar isso por canal ou por conta:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

Precedência: por conta → por canal → padrões do canal → padrões embutidos.

### O que cada flag faz

- `showOk`: envia um reconhecimento `HEARTBEAT_OK` quando o modelo retorna uma resposta apenas OK.
- `showAlerts`: envia o conteúdo do alerta quando o modelo retorna uma resposta não-OK.
- `useIndicator`: emite eventos indicadores para superfícies de status da UI.

Se **os três** forem falsos, o OpenClaw ignora a execução de heartbeat inteiramente (nenhuma chamada ao modelo).

### Exemplos por canal vs por conta

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### Padrões comuns

| Objetivo                                                                  | Configuração                                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Comportamento padrão (OKs silenciosos, alertas ativos) | _(nenhuma configuração necessária)_                                   |
| Totalmente silencioso (sem mensagens, sem indicador)   | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| Apenas indicador (sem mensagens)                       | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| OKs em apenas um canal                                                    | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (opcional)

Se existir um arquivo `HEARTBEAT.md` no workspace, o prompt padrão instrui o
agente a lê-lo. Pense nele como sua “checklist de heartbeat”: pequena, estável e
segura para incluir a cada 30 minutos.

Se `HEARTBEAT.md` existir mas estiver efetivamente vazio (apenas linhas em branco e cabeçalhos
Markdown como `# Heading`), o OpenClaw ignora a execução de heartbeat para economizar chamadas de API.
Se o arquivo estiver ausente, o heartbeat ainda é executado e o modelo decide o que fazer.

Mantenha-o pequeno (checklist curta ou lembretes) para evitar inchaço de prompt.

Exemplo de `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### O agente pode atualizar o HEARTBEAT.md?

Sim — se você pedir.

`HEARTBEAT.md` é apenas um arquivo normal no workspace do agente, então você pode dizer ao
agente (em um chat normal) algo como:

- “Atualize `HEARTBEAT.md` para adicionar uma verificação diária do calendário.”
- “Reescreva `HEARTBEAT.md` para ficar mais curto e focado em acompanhamentos da caixa de entrada.”

Se você quiser que isso aconteça proativamente, também pode incluir uma linha explícita no
seu prompt de heartbeat como: “Se a checklist ficar desatualizada, atualize HEARTBEAT.md
com uma melhor.”

Nota de segurança: não coloque segredos (chaves de API, números de telefone, tokens privados) em
`HEARTBEAT.md` — ele passa a fazer parte do contexto do prompt.

## Despertar manual (sob demanda)

Você pode enfileirar um evento do sistema e acionar um heartbeat imediato com:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

Se vários agentes tiverem `heartbeat` configurado, um despertar manual executa imediatamente
os heartbeats de cada um desses agentes.

Use `--mode next-heartbeat` para aguardar o próximo tick agendado.

## Entrega de raciocínio (opcional)

Por padrão, os heartbeats entregam apenas a carga final de “resposta”.

Se você quiser transparência, habilite:

- `agents.defaults.heartbeat.includeReasoning: true`

Quando habilitado, os heartbeats também entregarão uma mensagem separada prefixada
com `Reasoning:` (mesmo formato de `/reasoning on`). Isso pode ser útil quando o agente
está gerenciando várias sessões/códices e você quer ver por que decidiu enviar uma notificação
— mas também pode vazar mais detalhes internos do que você deseja. Prefira manter isso
desativado em chats de grupo.

## Consciência de custo

Os heartbeats executam turnos completos do agente. Intervalos mais curtos consomem mais tokens. Mantenha `HEARTBEAT.md` pequeno e considere um `model` ou `target: "none"` mais barato se você
quiser apenas atualizações de estado internas.
