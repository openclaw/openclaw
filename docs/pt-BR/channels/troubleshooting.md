---
summary: "Solução rápida de problemas no nível de canal com assinaturas de falha por canal e correções"
read_when:
  - O transporte do canal indica conectado, mas as respostas falham
  - Voce precisa de verificações específicas do canal antes de consultar a documentação profunda do provedor
title: "Solução de problemas de canal"
---

# Solução de problemas de canal

Use esta página quando um canal se conecta, mas o comportamento está incorreto.

## Escada de comandos

Execute estes na ordem primeiro:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Linha de base saudável:

- `Runtime: running`
- `RPC probe: ok`
- A sondagem do canal mostra conectado/pronto

## WhatsApp

### Assinaturas de falha do WhatsApp

| Sintoma                                 | Verificação mais rápida                                        | Correção                                                                                      |
| --------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Conectado, mas sem respostas em DM      | `openclaw pairing list whatsapp`                               | Aprovar remetente ou trocar a política de DM/lista de permissões.             |
| Mensagens de grupo ignoradas            | Verifique `requireMention` + padrões de menção na configuração | Mencione o bot ou relaxe a política de menção para esse grupo.                |
| Desconexões aleatórias/loops de relogin | `openclaw channels status --probe` + logs                      | Faça login novamente e verifique se o diretório de credenciais está saudável. |

Solução completa: [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Assinaturas de falha do Telegram

| Sintoma                                       | Verificação mais rápida                                        | Correção                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/start` mas sem fluxo de resposta utilizável | `openclaw pairing list telegram`                               | Aprovar pareamento ou alterar a política de DM.                              |
| Bot online, mas o grupo permanece silencioso  | Verifique o requisito de menção e o modo de privacidade do bot | Desative o modo de privacidade para visibilidade no grupo ou mencione o bot. |
| Falhas de envio com erros de rede             | Inspecione os logs para falhas de chamada da API do Telegram   | Corrija DNS/IPv6/roteamento de proxy para `api.telegram.org`.                |

Solução completa: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Assinaturas de falha do Discord

| Sintoma                                   | Verificação mais rápida                   | Correção                                                                                |
| ----------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| Bot online, mas sem respostas no servidor | `openclaw channels status --probe`        | Permita o servidor/canal e verifique a intent de conteúdo de mensagens. |
| Mensagens de grupo ignoradas              | Verifique os logs por bloqueios de menção | Mencione o bot ou defina o servidor/canal `requireMention: false`.      |
| Respostas em DM ausentes                  | `openclaw pairing list discord`           | Aprovar pareamento de DM ou ajustar a política de DM.                   |

Solução completa: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Assinaturas de falha do Slack

| Sintoma                                  | Verificação mais rápida                                  | Correção                                                                          |
| ---------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Modo socket conectado, mas sem respostas | `openclaw channels status --probe`                       | Verifique o token do app + token do bot e os escopos necessários. |
| DMs bloqueadas                           | `openclaw pairing list slack`                            | Aprovar pareamento ou relaxar a política de DM.                   |
| Mensagem de canal ignorada               | Verifique `groupPolicy` e a lista de permissões do canal | Permita o canal ou troque a política para `open`.                 |

Solução completa: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage e BlueBubbles

### Assinaturas de falha do iMessage e BlueBubbles

| Sintoma                                   | Verificação mais rápida                                                    | Correção                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Nenhum evento de entrada                  | Verifique a alcançabilidade do webhook/servidor e as permissões do app     | Corrija a URL do webhook ou o estado do servidor BlueBubbles. |
| Consegue enviar, mas não receber no macOS | Verifique as permissões de privacidade do macOS para automação do Messages | Reautorize as permissões TCC e reinicie o processo do canal.  |
| Remetente de DM bloqueado                 | `openclaw pairing list imessage` ou `openclaw pairing list bluebubbles`    | Aprovar pareamento ou atualizar a lista de permissões.        |

Solução completa:

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### Assinaturas de falha do Signal

| Sintoma                              | Verificação mais rápida                                         | Correção                                                                              |
| ------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Daemon acessível, mas bot silencioso | `openclaw channels status --probe`                              | Verifique a URL/conta do daemon `signal-cli` e o modo de recebimento. |
| DM bloqueada                         | `openclaw pairing list signal`                                  | Aprovar remetente ou ajustar a política de DM.                        |
| Respostas em grupo não disparam      | Verifique a lista de permissões do grupo e os padrões de menção | Adicione remetente/grupo ou afrouxe o bloqueio.                       |

Solução completa: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## Matrix

### Assinaturas de falha do Matrix

| Sintoma                              | Verificação mais rápida                                               | Correção                                                                    |
| ------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Logado, mas ignora mensagens da sala | `openclaw channels status --probe`                                    | Verifique `groupPolicy` e a lista de permissões da sala.    |
| DMs não são processadas              | `openclaw pairing list matrix`                                        | Aprovar remetente ou ajustar a política de DM.              |
| Salas criptografadas falham          | Verifique o módulo de criptografia e as configurações de criptografia | Ative o suporte à criptografia e reentre/sincronize a sala. |

Solução completa: [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
