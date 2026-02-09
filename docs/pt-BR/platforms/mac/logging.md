---
summary: "Registro do OpenClaw: arquivo de diagnóstico rotativo + flags de privacidade do registro unificado"
read_when:
  - Captura de logs do macOS ou investigação de registro de dados privados
  - Depuração de problemas do ciclo de vida de ativação/sessão de voz
title: "Registro no macOS"
---

# Registro (macOS)

## Arquivo de diagnóstico rotativo (painel de depuração)

O OpenClaw encaminha os logs do app no macOS pelo swift-log (registro unificado por padrão) e pode gravar um arquivo de log local e rotativo em disco quando voce precisa de uma captura durável.

- Verbosidade: **Painel de depuração → Logs → App logging → Verbosity**
- Ativar: **Painel de depuração → Logs → App logging → “Write rolling diagnostics log (JSONL)”**
- Localização: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (rotaciona automaticamente; arquivos antigos recebem os sufixos `.1`, `.2`, …)
- Limpar: **Painel de depuração → Logs → App logging → “Clear”**

Notas:

- Isto fica **desativado por padrão**. Ative apenas enquanto estiver depurando ativamente.
- Trate o arquivo como sensível; não compartilhe sem revisão.

## Dados privados no registro unificado do macOS

O registro unificado oculta a maioria dos payloads, a menos que um subsistema opte por `privacy -off`. Conforme o texto do Peter sobre macOS [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025), isso é controlado por um plist em `/Library/Preferences/Logging/Subsystems/` com chave pelo nome do subsistema. Apenas novas entradas de log aplicam a flag; portanto, ative antes de reproduzir um problema.

## Ativar para o OpenClaw (`bot.molt`)

- Escreva o plist primeiro em um arquivo temporário e depois instale-o atomicamente como root:

```bash
cat <<'EOF' >/tmp/bot.molt.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>DEFAULT-OPTIONS</key>
    <dict>
        <key>Enable-Private-Data</key>
        <true/>
    </dict>
</dict>
</plist>
EOF
sudo install -m 644 -o root -g wheel /tmp/bot.molt.plist /Library/Preferences/Logging/Subsystems/bot.molt.plist
```

- Nenhuma reinicialização é necessária; o logd percebe o arquivo rapidamente, mas apenas novas linhas de log incluirão payloads privados.
- Veja a saída mais rica com o utilitário existente, por exemplo, `./scripts/clawlog.sh --category WebChat --last 5m`.

## Desativar após a depuração

- Remova a substituição: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`.
- Opcionalmente, execute `sudo log config --reload` para forçar o logd a remover a substituição imediatamente.
- Lembre-se de que essa superfície pode incluir números de telefone e corpos de mensagens; mantenha o plist no lugar apenas enquanto voce precisar ativamente do detalhe extra.
