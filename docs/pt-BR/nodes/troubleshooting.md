---
summary: "Solução de problemas de pareamento de nós, requisitos de primeiro plano, permissões e falhas de ferramentas"
read_when:
  - O Node está conectado, mas as ferramentas de câmera/canvas/tela/exec falham
  - Você precisa do modelo mental de pareamento de nós versus aprovações
title: "Solução de problemas do Node"
---

# Solução de problemas do Node

Use esta página quando um node estiver visível no status, mas as ferramentas do node falharem.

## Escada de comandos

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Em seguida, execute verificações específicas do node:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

Sinais saudáveis:

- O Node está conectado e pareado para a função `node`.
- `nodes describe` inclui a capacidade que você está chamando.
- As aprovações de exec mostram o modo/lista de permissões esperados.

## Requisitos de primeiro plano

`canvas.*`, `camera.*` e `screen.*` funcionam apenas em primeiro plano em nodes iOS/Android.

Verificação e correção rápidas:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

Se você vir `NODE_BACKGROUND_UNAVAILABLE`, traga o app do node para o primeiro plano e tente novamente.

## Matriz de permissões

| Capacidade                   | iOS                                                          | Android                                                             | App de node no macOS                                        | Código de falha típico         |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------ |
| `camera.snap`, `camera.clip` | Câmera (+ microfone para áudio do clipe)  | Câmera (+ microfone para áudio do clipe)         | Câmera (+ microfone para áudio do clipe) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | Gravação de Tela (+ microfone opcional)   | Prompt de captura de tela (+ microfone opcional) | Gravação de Tela                                            | `*_PERMISSION_REQUIRED`        |
| `location.get`               | Durante o uso ou Sempre (depende do modo) | Localização em primeiro plano/segundo plano com base no modo        | Permissão de localização                                    | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n/a (caminho do host do node)             | n/a (caminho do host do node)                    | Aprovações de exec obrigatórias                             | `SYSTEM_RUN_DENIED`            |

## Pareamento versus aprovações

Estes são bloqueios diferentes:

1. **Pareamento do dispositivo**: este node pode se conectar ao gateway?
2. **Aprovações de exec**: este node pode executar um comando de shell específico?

Verificações rápidas:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

Se o pareamento estiver ausente, aprove primeiro o dispositivo do node.
Se o pareamento estiver ok, mas `system.run` falhar, corrija as aprovações de exec/lista de permissões.

## Códigos comuns de erro do node

- `NODE_BACKGROUND_UNAVAILABLE` → o app está em segundo plano; traga-o para o primeiro plano.
- `CAMERA_DISABLED` → alternância da câmera desativada nas configurações do node.
- `*_PERMISSION_REQUIRED` → permissão do SO ausente/negada.
- `LOCATION_DISABLED` → o modo de localização está desativado.
- `LOCATION_PERMISSION_REQUIRED` → o modo de localização solicitado não foi concedido.
- `LOCATION_BACKGROUND_UNAVAILABLE` → o app está em segundo plano, mas existe apenas a permissão Durante o uso.
- `SYSTEM_RUN_DENIED: approval required` → a solicitação de exec precisa de aprovação explícita.
- `SYSTEM_RUN_DENIED: allowlist miss` → comando bloqueado pelo modo de lista de permissões.

## Loop rápido de recuperação

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

Se ainda estiver com problemas:

- Reaprovar o pareamento do dispositivo.
- Reabrir o app do node (primeiro plano).
- Conceder permissões de SO novamente.
- Recriar/ajustar a política de aprovação de exec.

Relacionado:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
