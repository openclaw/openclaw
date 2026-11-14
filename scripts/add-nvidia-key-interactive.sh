#!/usr/bin/env bash
# Ввод NVIDIA API token в кошелёк secret-wallet + проверка на integrate.api.nvidia.com.
#
# Способы передать токен (значение не печатается, не попадает в argv и историю):
#
#   1) Интерактивно:
#        bash /home/zero/openclaw/scripts/add-nvidia-key-interactive.sh
#      Дождитесь приглашения "NVIDIA API token:" и ТОЛЬКО ПОТОМ вставьте токен + Enter.
#
#   2) Через файл:
#        nano ~/.nvidia-key            # вставьте токен, сохраните
#        chmod 600 ~/.nvidia-key
#        bash /home/zero/openclaw/scripts/add-nvidia-key-interactive.sh ~/.nvidia-key
#      Файл удаляется после успешной записи.
set -uo pipefail

WALLET_DIR=/home/zero/secret-wallet
KEYFILE="${1:-}"

if [ -n "$KEYFILE" ]; then
  if [ ! -f "$KEYFILE" ]; then echo "✗ файл не найден: $KEYFILE"; exit 1; fi
  KEY=$(tr -d '\r\n' < "$KEYFILE" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  echo "→ токен прочитан из файла $KEYFILE"
else
  KEY=""
  for attempt in 1 2 3 4 5; do
    printf 'NVIDIA API token (вставьте токен и нажмите Enter): '
    IFS= read -r -s KEY
    echo
    KEY=$(printf '%s' "$KEY" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    if [ -n "$KEY" ]; then break; fi
    echo "  ничего не прочитано (попытка $attempt/5). Вставьте токен В ОКНЕ ТЕРМИНАЛА, когда видите приглашение."
  done
fi

if [ -z "${KEY//[[:space:]]/}" ]; then
  echo "✗ пусто, ничего не записано."
  exit 1
fi

LEN=${#KEY}
SHA=$(printf '%s' "$KEY" | sha256sum | cut -c1-12)
PREFIX=$(printf '%s' "$KEY" | cut -c1-10)
echo "→ введено: len=$LEN sha12=$SHA префикс=${PREFIX}…"

# Проверка: NVIDIA API должен отдать список моделей.
# Ключ передаётся через переменную окружения, а не через stdin: heredoc
# перебивает stdin-пайп, и скрипт проверял пустую строку вместо токена
# (симптом: «токен не прошёл проверку», в кошелёк ничего не пишется).
NVIDIA_KEY="$KEY" python3 - <<'PY'
import json, os, sys, urllib.request, urllib.error
key = os.environ.get("NVIDIA_KEY", "").strip()
if not key:
    print("  NVIDIA_KEY не передан — проверять нечего")
    sys.exit(3)
req = urllib.request.Request("https://integrate.api.nvidia.com/v1/models",
                             headers={"Authorization": "Bearer " + key,
                                      "Accept": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read().decode())
    ids = [m.get("id", "") for m in data.get("data", [])]
    print("  NVIDIA API: HTTP 200, моделей доступно %d" % len(ids))
    for x in ids[:40]:
        print("    -", x)
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print("  NVIDIA API отклонил токен: HTTP %s %s" % (e.code, body[:160]))
    sys.exit(2)
except Exception as e:
    print("  NVIDIA API недоступен: %s: %s" % (type(e).__name__, e))
    sys.exit(3)
PY
RC=$?

if [ "$RC" != "0" ]; then
  echo "✗ токен не прошёл проверку - в кошелёк не записываю."
  exit 4
fi

cd "$WALLET_DIR"
printf '%s\n' "$KEY" | python3 wallet.py add nvidia_api_key
unset KEY
if [ -n "$KEYFILE" ] && [ -f "$KEYFILE" ]; then
  rm -f "$KEYFILE" && echo "→ временный файл с токеном удалён: $KEYFILE"
fi

python3 - <<'PY'
import hashlib, sys
sys.path.insert(0, "/home/zero/secret-wallet")
from engine import wallet as w
rec = w.get_secret("nvidia_api_key")
v = rec["current"]["value"]
print("  кошелёк: v%s len=%d sha12=%s" % (rec["current"]["version"], len(v),
                                         hashlib.sha256(v.encode()).hexdigest()[:12]))
PY

echo
echo "Готово. Дальше: подключение NVIDIA к шлюзу"
echo "  bash /home/zero/openclaw/scripts/enable-nvidia.sh"
