#!/usr/bin/env bash
# Ввод M Plan API key в кошелёк + диагностика эндпоинтов.
#
# Способы передать ключ (значение нигде не печатается и не попадает в argv):
#
#   1) Интерактивно (основной):
#        bash /home/zero/openclaw/scripts/add-mplan-key-interactive.sh
#      Дождитесь строки "M Plan API key:" и ТОЛЬКО ПОТОМ вставьте ключ + Enter.
#
#   2) Через файл (если вставка в терминал не работает):
#        nano ~/.mplan-key            # вставьте ключ, сохраните, закройте
#        chmod 600 ~/.mplan-key
#        bash /home/zero/openclaw/scripts/add-mplan-key-interactive.sh ~/.mplan-key
#      Файл удаляется сразу после успешной записи в кошелёк.
set -uo pipefail

WALLET_DIR=/home/zero/secret-wallet
KEYFILE="${1:-}"

# ── получаем ключ ──────────────────────────────────────────────────────────
if [ -n "$KEYFILE" ]; then
  if [ ! -f "$KEYFILE" ]; then
    echo "✗ файл не найден: $KEYFILE"
    exit 1
  fi
  KEY=$(tr -d '\r\n' < "$KEYFILE" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  echo "→ ключ прочитан из файла $KEYFILE"
else
  KEY=""
  for attempt in 1 2 3 4 5; do
    printf 'M Plan API key (вставьте ключ и нажмите Enter): '
    IFS= read -r -s KEY
    echo
    KEY=$(printf '%s' "$KEY" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    if [ -n "$KEY" ]; then
      break
    fi
    echo "  ничего не прочитано (попытка $attempt/5). Вставьте ключ В ОКНЕ ТЕРМИНАЛА, когда видите приглашение выше."
  done
fi

if [ -z "${KEY//[[:space:]]/}" ]; then
  echo "✗ ключ пуст, ничего не записано."
  exit 1
fi

LEN=${#KEY}
SHA=$(printf '%s' "$KEY" | sha256sum | cut -c1-12)
KIND=$(case "$KEY" in
  sk-*) echo "sk-* (API-ключ)";;
  eyJ*) echo "eyJ… (JWT-подобный токен)";;
  mmoat_*|mmort_*) echo "mmoat/mm… (токен MiniMax Code)";;
  *) echo "неизвестный формат";;
esac)
echo "→ введено: len=$LEN sha12=$SHA формат=$KIND"

# ── диагностика + проверка ─────────────────────────────────────────────────
# Ключ передаётся через переменную окружения, а не через stdin: heredoc
# перебивает stdin-пайп, и скрипт проверял пустую строку вместо ключа
# (симптом: «не прошёл проверку», в кошелёк ничего не пишется).
MPLAN_KEY="$KEY" python3 - <<'PY'
import json, os, sys, urllib.request, urllib.error

key = os.environ.get("MPLAN_KEY", "").strip()
if not key:
    print("  MPLAN_KEY не передан — проверять нечего")
    sys.exit(3)
CHAT = {"model": "MiniMax-M3.1-Flash", "max_tokens": 24,
        "messages": [{"role": "user", "content": "Reply with exactly: OK"}]}

def probe(label, url, headers, payload=None, method="POST"):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            body = r.read().decode()
            print("  [%-26s] HTTP %s OK" % (label, r.status))
            return True, body
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        err = ""
        try:
            j = json.loads(body)
            err = j.get("error", j)
            if isinstance(err, dict):
                err = err.get("message") or json.dumps(err)
        except Exception:
            err = body[:160]
        print("  [%-26s] HTTP %s : %s" % (label, e.code, str(err)[:170]))
        return False, body
    except Exception as e:
        print("  [%-26s] EXC %s: %s" % (label, type(e).__name__, e))
        return False, ""

def probe_legacy(url, headers, payload):
    """Legacy-эндпоинт MiniMax отвечает HTTP 200 даже при неверном ключе:
    ошибка лежит внутри base_resp. Поэтому 200 здесь не считается успехом."""
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            body = r.read().decode()
            try:
                j = json.loads(body)
            except Exception:
                print("  [%-26s] HTTP %s (не-JSON)" % (url.split("//")[1][:26], r.status))
                return False
            base = j.get("base_resp") or {}
            code = base.get("status_code")
            msg = base.get("status_msg", "")
            if code in (0, None) and (j.get("choices") or j.get("reply")):
                print("  [%-26s] HTTP %s OK" % (url.split("//")[1][:26], r.status))
                return True
            print("  [%-26s] HTTP %s : base_resp=%s %s" % (url.split("//")[1][:26], r.status, code, str(msg)[:120]))
            return False
    except urllib.error.HTTPError as e:
        print("  [%-26s] HTTP %s" % (url.split("//")[1][:26], e.code))
        return False
    except Exception as e:
        print("  [%-26s] EXC %s: %s" % (url.split("//")[1][:26], type(e).__name__, e))
        return False

bearer = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
xkey = {"x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"}

print("  --- список моделей ---")
ok, body = probe("models global", "https://api.minimax.io/v1/models", bearer, None, "GET")
if ok:
    try:
        ids = [m.get("id") for m in json.loads(body).get("data", [])]
        print("      доступные модели: %s" % ", ".join(str(i) for i in ids[:12]))
    except Exception:
        pass

print("  --- чат-комплишены ---")
oks = []
for label, url, headers in (
        ("global openai", "https://api.minimax.io/v1/chat/completions", bearer),
        ("global anthropic", "https://api.minimax.io/anthropic/v1/messages", xkey),
        ("cn openai", "https://api.minimaxi.chat/v1/chat/completions", bearer)):
    ok, _ = probe(label, url, headers, CHAT)
    oks.append(ok)

# legacy - отдельно: там 200 не значит успех
if probe_legacy("https://api.minimax.io/v1/text/chatcompletion_v2", bearer, CHAT):
    oks.append(True)

if not any(oks):
    print("  → ни один эндпоинт не принял ключ.")
    sys.exit(2)
print("  → ключ рабочий.")
PY
RC=$?

if [ "$RC" != "0" ]; then
  echo "✗ ключ не прошёл проверку - в кошелёк не записываю."
  [ -n "$KEYFILE" ] && [ -f "$KEYFILE" ] && echo "  (файл $KEYFILE оставлен на месте)"
  exit 4
fi

# ── запись в кошелёк ────────────────────────────────────────────────────────
cd "$WALLET_DIR"
printf '%s\n' "$KEY" | python3 wallet.py add minimax_mplan_api_key
unset KEY
if [ -n "$KEYFILE" ] && [ -f "$KEYFILE" ]; then
  rm -f "$KEYFILE" && echo "→ временный файл с ключом удалён: $KEYFILE"
fi

python3 - <<'PY'
import hashlib, sys
sys.path.insert(0, "/home/zero/secret-wallet")
from engine import wallet as w
rec = w.get_secret("minimax_mplan_api_key")
v = rec["current"]["value"]
print("  кошелёк: v%s len=%d sha12=%s" % (rec["current"]["version"], len(v),
                                         hashlib.sha256(v.encode()).hexdigest()[:12]))
PY

echo
echo "Готово. Включаем прямой MiniMax:"
echo "  bash /home/zero/openclaw/scripts/enable-minimax-direct.sh"
