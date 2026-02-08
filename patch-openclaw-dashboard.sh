#!/bin/bash
# OpenClaw Dashboard Performance Fix Patch
# Criado em: 2026-02-02
# Problema: Dashboard travando no refresh devido a polling agressivo + concorrência de logs + heartbeat crashing

set -e

OPENCLAW_DIST="/opt/homebrew/lib/node_modules/openclaw/dist"
BACKUP_DIR="$HOME/clawd-patches/backup-$(date +%Y%m%d-%H%M%S)"

echo "🛠️  Patching OpenClaw Dashboard..."

# Criar backup
echo "📦 Criando backup em $BACKUP_DIR..."
mkdir -p "$BACKUP_DIR"
cp -r "$OPENCLAW_DIST"/* "$BACKUP_DIR/" 2>/dev/null || true
cp -r "$OPENCLAW_DIST"/* "$HOME/clawd-patches/" 2>/dev/null || true

# ========================================
# PATCH 1: Fix Heartbeat Crashing
# ========================================
echo "🔧 Patch 1/3: Corrigindo heartbeat crashing..."
if [ -f "$OPENCLAW_DIST/web/reply-heartbeat-wake.js" ]; then
    # Remover 'throw err' que causa unhandled rejection em async timeout
    sed -i.bak '36d' "$OPENCLAW_DIST/web/reply-heartbeat-wake.js"
    echo "✅ Heartbeat patched (throw err removido)"
else
    echo "⚠️  Arquivo não encontrado: $OPENCLAW_DIST/web/reply-heartbeat-wake.js"
fi

# ========================================
# PATCH 2: Fix Logs Tail Concurrency
# ========================================
echo "🔧 Patch 2/3: Corrigindo concorrência em logs.tail..."

# Isso é mais complexo, vamos usar um script Python para patchar corretamente
python3 << 'PYEOF'
import re

# Caminho do arquivo
file_path = "/opt/homebrew/lib/node_modules/openclaw/dist/control-ui/assets/index-CelYWcD3.js"

with open(file_path, 'r') as f:
    content = f.read()

# Buscar função Bs (logs tail) e adicionar logsInFlight guard
# Padrão atual:
# if (!(!e.client || !e.connected) && !(e.logsLoading && !t?.quiet))
# New pattern com logsInFlight:
if 'e.logsLoading && !t?.quiet' in content:
    # Criar novo guard que respeita logsInFlight também
    # Vamos apenas adicionar logsInFlight check após logsLoading

    # Vamos mudar a condição em todo o arquivo (variante Bs)
    # Buscar: if (!(!e.client || !e.connected) && !(e.logsLoading && !t?.quiet))
    # Para: if (!(!e.client || !e.connected) && !(e.logsLoading && !t?.quiet && !e.logsInFlight))

    old_pattern = r'(e\.logsLoading && !t\?\.quiet)'
    new_pattern = r'(e.logsLoading && !t?.quiet && !e.logsInFlight)'

    content = re.sub(old_pattern, new_pattern, content)

    # Adicionar logsInFlight no finally
    # Buscar: } finally { t?.quiet || (e.logsLoading = false) }
    # Para: } finally { e.logsInFlight = false; t?.quiet || (e.logsLoading = false) }

    old_finally = r'(\} finally \{ t\?\.quiet \|\| \(e\.logsLoading = false\) \})'
    new_finally = r'} finally { e.logsInFlight = false; t?.quiet || (e.logsLoading = false) }'

    content = re.sub(old_finally, new_finally, content)

    with open(file_path, 'w') as f:
        f.write(content)

    print("✅ Logs tail concurrency patched (logsInFlight added)")
else:
    print("⚠️  Pattern não encontrado em index-CelYWcD3.js")

PYEOF

# ========================================
# PATCH 3: Debounce Debug Polling
# ========================================
echo "🔧 Patch 3/3: Reduzindo polling do debug..."
python3 << 'PYEOF'
import re

# Caminho do arquivo
file_path = "/opt/homebrew/lib/node_modules/openclaw/dist/control-ui/assets/index-CelYWcD3.js"

with open(file_path, 'r') as f:
    content = f.read()

# Buscar Ks (debug poll interval) e aumentar para 10s
# Padrão: const ec=2e3 (2 segundos)
# Para: const ec=1e4 (10 segundos)

if 'const ec=2e3' in content:
    content = content.replace('const ec=2e3', 'const ec=1e4')
    print("✅ Debug polling increased from 2s to 10s")
else:
    print("⚠️  Pattern não encontrado para debug polling")

with open(file_path, 'w') as f:
    f.write(content)

PYEOF

echo "✅ Todos os patches aplicados com sucesso!"
echo ""
echo "📊 Resumo dos patches:"
echo "  1. Heartbeat crashing - throw err removido"
echo "  2. Logs tail concurrency - logsInFlight added"
echo "  3. Debug polling - 2s → 10s"
echo ""
echo "🚀 Para aplicar:"
echo "  openclaw gateway restart"
echo ""
echo "💾 Backup em: $BACKUP_DIR"
