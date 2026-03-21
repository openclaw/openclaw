"""
product_watchdog — thinker.cafe 產品線監控

每小時檢查：
1. thinker.cafe AI 聊天是否正常
2. LLM proxy 是否活著（localhost:18799）
3. Cloudflare tunnel 是否活著
4. Dev.to 文章 views/reactions
5. USDT 錢包有無新入帳
6. Proxy 掛了自動重啟

結果推送到戰情室。
"""

import json
import os
import subprocess
import urllib.request
import time
from datetime import datetime

TRON_API = "https://api.trongrid.io"
TRONGRID_KEY = "9c9ef5c6-af2d-470f-9ac3-ac8ccd8e7887"
WALLET = "TT1rC387qkvfLE1FUAN1bR1jPudAh1qNKz"
USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
DEVTO_KEY = "dXihES3AJEgn3Ze8FBvxZjTx"
PROXY_PORT = 18799
PROXY_SCRIPT = os.path.expanduser("~/clawd/workspace/tools/llm-proxy/server.py")
STATE_FILE = os.path.join(os.path.dirname(__file__), "..", "state.json")

# Last known USDT tx timestamp — avoid re-alerting
_last_usdt_ts = 0


def _fetch_json(url, headers=None, timeout=15):
    """Fetch JSON from URL."""
    req = urllib.request.Request(url)
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return None


def check_proxy():
    """Check if LLM proxy is alive."""
    data = _fetch_json(f"http://localhost:{PROXY_PORT}/", timeout=5)
    if data and data.get("status") == "ok":
        return True, "ok"
    return False, "down"


def restart_proxy():
    """Restart LLM proxy."""
    subprocess.run(["pkill", "-f", "llm-proxy/server.py"], capture_output=True)
    time.sleep(2)
    proxy_dir = os.path.dirname(PROXY_SCRIPT)
    subprocess.Popen(
        f"cd {proxy_dir} && python3 server.py --port {PROXY_PORT} > /tmp/llm-proxy.log 2>&1",
        shell=True,
    )
    time.sleep(3)
    alive, _ = check_proxy()
    return alive


def check_chat():
    """Check if thinker.cafe AI chat works."""
    try:
        data = json.dumps({
            "messages": [{"role": "user", "content": "ping"}]
        }).encode()
        req = urllib.request.Request(
            "https://thinker.cafe/api/chat",
            data=data, method="POST",
        )
        req.add_header("Content-Type", "application/json")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=30) as resp:
            result = json.loads(resp.read().decode())
            if result.get("text"):
                return True, "ok"
            return False, result.get("error", "no text")
    except Exception as e:
        return False, str(e)[:50]


def check_devto():
    """Get Dev.to article stats."""
    data = _fetch_json(
        "https://dev.to/api/articles/me/published",
        headers={"api-key": DEVTO_KEY},
    )
    if not data:
        return {"views": 0, "reactions": 0, "comments": 0, "articles": 0}
    return {
        "views": sum(a.get("page_views_count", 0) for a in data),
        "reactions": sum(a.get("positive_reactions_count", 0) for a in data),
        "comments": sum(a.get("comments_count", 0) for a in data),
        "articles": len(data),
    }


def check_usdt():
    """Check for new USDT transactions."""
    global _last_usdt_ts
    data = _fetch_json(
        f"{TRON_API}/v1/accounts/{WALLET}/transactions/trc20?limit=3&contract_address={USDT_CONTRACT}",
        headers={"TRON-PRO-API-KEY": TRONGRID_KEY},
    )
    if not data or not data.get("data"):
        return None

    latest = data["data"][0]
    ts = latest.get("block_timestamp", 0)
    amount = int(latest.get("value", 0)) / 1_000_000
    from_addr = latest.get("from", "?")[:12]
    to_addr = latest.get("to", "?")[:12]

    is_incoming = to_addr.startswith(WALLET[:12])
    is_new = ts > _last_usdt_ts

    if is_new and is_incoming and _last_usdt_ts > 0:
        _last_usdt_ts = ts
        return {"new": True, "amount": amount, "from": from_addr, "ts": ts}

    _last_usdt_ts = ts
    return {"new": False, "amount": amount}


def run(notify_fn=None, **kwargs):
    """Main watchdog run."""
    now = datetime.now().strftime("%H:%M")
    results = []

    # 1. Proxy
    proxy_ok, proxy_msg = check_proxy()
    if not proxy_ok:
        restarted = restart_proxy()
        proxy_msg = "restarted→ok" if restarted else "restarted→FAIL"
    results.append(f"Proxy:{proxy_msg}")

    # 2. Chat
    chat_ok, chat_msg = check_chat()
    results.append(f"Chat:{'ok' if chat_ok else chat_msg}")

    # 3. Dev.to
    devto = check_devto()
    results.append(f"Dev.to:V{devto['views']}R{devto['reactions']}C{devto['comments']}")

    # 4. USDT
    usdt = check_usdt()
    if usdt and usdt.get("new"):
        sale_msg = f"💰 NEW USDT: {usdt['amount']}U from {usdt['from']}"
        results.append(sale_msg)
        if notify_fn:
            notify_fn(sale_msg)
    else:
        results.append("USDT:no new")

    # Summary
    summary = f"[product] {now} | {' | '.join(results)}"
    print(summary)

    # Notify only on issues or sales
    has_issue = not proxy_ok or not chat_ok
    has_sale = usdt and usdt.get("new")

    if (has_issue or has_sale) and notify_fn:
        notify_fn(summary)

    return {"ok": proxy_ok and chat_ok, "summary": summary}
