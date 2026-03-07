from __future__ import annotations

import json

import httpx
import respx

from packages.integrations.ghl.client import GHLClient


@respx.mock
def test_ghl_upsert_contact_request_shape():
    client = GHLClient(api_key="k", base_url="https://rest.gohighlevel.com")
    route = respx.post("https://rest.gohighlevel.com/v1/contacts/").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    resp = client.upsert_contact({"name": "DA", "tags": ["lead"]})
    assert resp["ok"] is True
    assert route.called
    sent = json.loads(route.calls[0].request.content)
    assert sent["name"] == "DA"
