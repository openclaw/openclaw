from __future__ import annotations

import httpx
import respx

from packages.integrations.ghl.client import GHLClient


@respx.mock
def test_ghl_update_contact_custom_fields_shape():
    client = GHLClient(api_key="k", base_url="https://rest.gohighlevel.com")
    route = respx.put("https://rest.gohighlevel.com/v1/contacts/ghl_123").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )

    resp = client.update_contact_custom_fields("ghl_123", {"TrelloBoardId": "b1"})
    assert resp["ok"] is True
    assert route.called
    sent = route.calls[0].request
    import json

    body = json.loads(sent.content)
    assert "customField" in body
    assert body["customField"]["TrelloBoardId"] == "b1"
