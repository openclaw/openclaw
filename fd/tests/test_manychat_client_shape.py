from __future__ import annotations

import json

import httpx
import respx

from packages.integrations.manychat.client import ManyChatClient


@respx.mock
def test_manychat_send_text_request_shape():
    client = ManyChatClient(api_key="k", base_url="https://api.manychat.com")
    route = respx.post("https://api.manychat.com/fb/sending/sendContent").mock(
        return_value=httpx.Response(200, json={"status": "ok"})
    )
    resp = client.send_text("sub123", "hello")
    assert resp["status"] == "ok"
    assert route.called
    sent = json.loads(route.calls[0].request.content)
    assert sent["subscriber_id"] == "sub123"
    assert "message" in sent and "text" in sent["message"]
