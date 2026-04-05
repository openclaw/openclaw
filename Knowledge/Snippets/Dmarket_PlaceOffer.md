# Dmarket — Place Offer Snippet

#golden_snippet

```python
import hmac, hashlib, time, requests

def sign_request(secret: str, method: str, path: str, body: str = "") -> dict:
    ts = str(int(time.time()))
    msg = method.upper() + path + ts + body
    sig = hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()
    return {"X-Sign-Date": ts, "X-Request-Sign": "dmar " + sig}

def place_offer(api_key: str, secret: str, item_id: str, price: float) -> dict:
    path = "/exchange/v1/offers"
    body = f'{{"itemId":"{item_id}","price":{{"amount":"{price:.2f}","currency":"USD"}}}}'
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    headers.update(sign_request(secret, "POST", path, body))
    r = requests.post("https://api.dmarket.com" + path, data=body, headers=headers, timeout=10)
    r.raise_for_status()
    return r.json()
```
