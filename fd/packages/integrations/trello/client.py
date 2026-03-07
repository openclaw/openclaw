from __future__ import annotations

from typing import Any

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt

from packages.common.config import settings
from packages.integrations.trello.rate_limit import (
    TrelloRateLimitError,
    TrelloServerError,
    raise_for_status_rate_limit,
    wait_with_retry_after,
)

_RETRY = dict(
    reraise=True,
    stop=stop_after_attempt(6),
    wait=wait_with_retry_after,
    retry=retry_if_exception_type((httpx.HTTPError, TrelloRateLimitError, TrelloServerError)),
)


class TrelloClient:
    def __init__(self, key: str | None = None, token: str | None = None) -> None:
        self.key = key or settings.TRELLO_KEY
        self.token = token or settings.TRELLO_TOKEN
        self._client = httpx.Client(timeout=20.0)

    def _params(self) -> dict[str, str]:
        return {"key": self.key, "token": self.token}

    @retry(**_RETRY)
    def create_board(
        self,
        *,
        name: str,
        id_organization: str = "",
        org_id: str = "",
        visibility: str = "private",
    ) -> dict[str, Any]:
        org = id_organization or org_id
        payload: dict[str, str] = {"name": name, "defaultLists": "false"}
        if org:
            payload["idOrganization"] = org
        if visibility:
            payload["prefs_permissionLevel"] = visibility
        url = "https://api.trello.com/1/boards/"
        resp = self._client.post(url, params=self._params(), data=payload)
        raise_for_status_rate_limit(resp)
        return resp.json()

    @retry(**_RETRY)
    def create_list(self, *, board_id: str, name: str) -> dict[str, Any]:
        url = "https://api.trello.com/1/lists"
        payload = {"idBoard": board_id, "name": name}
        resp = self._client.post(url, params=self._params(), data=payload)
        raise_for_status_rate_limit(resp)
        return resp.json()

    @retry(**_RETRY)
    def create_card(self, *, list_id: str, name: str, desc: str = "") -> dict[str, Any]:
        url = "https://api.trello.com/1/cards"
        payload = {"idList": list_id, "name": name, "desc": desc}
        resp = self._client.post(url, params=self._params(), data=payload)
        raise_for_status_rate_limit(resp)
        return resp.json()

    @retry(**_RETRY)
    def get_lists(self, *, board_id: str) -> list[dict[str, Any]]:
        url = f"https://api.trello.com/1/boards/{board_id}/lists"
        resp = self._client.get(url, params=self._params())
        raise_for_status_rate_limit(resp)
        return resp.json()

    @retry(**_RETRY)
    def get_card(self, *, card_id: str) -> dict[str, Any]:
        url = f"https://api.trello.com/1/cards/{card_id}"
        resp = self._client.get(url, params=self._params())
        raise_for_status_rate_limit(resp)
        return resp.json()

    @retry(**_RETRY)
    def move_card(self, *, card_id: str, list_id: str) -> dict[str, Any]:
        url = f"https://api.trello.com/1/cards/{card_id}"
        resp = self._client.put(url, params=self._params(), data={"idList": list_id})
        raise_for_status_rate_limit(resp)
        return resp.json()

    @retry(**_RETRY)
    def create_webhook(self, *, board_id: str, callback_url: str, description: str) -> dict[str, Any]:
        url = "https://api.trello.com/1/webhooks"
        payload = {"idModel": board_id, "callbackURL": callback_url, "description": description}
        resp = self._client.post(url, params=self._params(), data=payload)
        raise_for_status_rate_limit(resp)
        return resp.json()

    @retry(**_RETRY)
    def delete_webhook(self, *, webhook_id: str) -> dict[str, Any]:
        url = f"https://api.trello.com/1/webhooks/{webhook_id}"
        resp = self._client.delete(url, params=self._params())
        raise_for_status_rate_limit(resp)
        return {"ok": True, "webhook_id": webhook_id, "status_code": resp.status_code}

    @retry(**_RETRY)
    def close_board(self, *, board_id: str) -> dict[str, Any]:
        url = f"https://api.trello.com/1/boards/{board_id}"
        resp = self._client.put(url, params=self._params(), data={"closed": "true"})
        raise_for_status_rate_limit(resp)
        return resp.json()

    @retry(**_RETRY)
    def get_labels(self, *, board_id: str) -> list[dict[str, Any]]:
        url = f"https://api.trello.com/1/boards/{board_id}/labels"
        resp = self._client.get(url, params=self._params())
        raise_for_status_rate_limit(resp)
        return resp.json()

    @retry(**_RETRY)
    def create_label(self, *, board_id: str, name: str, color: str = "yellow") -> dict[str, Any]:
        url = "https://api.trello.com/1/labels"
        payload = {"idBoard": board_id, "name": name, "color": color}
        resp = self._client.post(url, params=self._params(), data=payload)
        raise_for_status_rate_limit(resp)
        return resp.json()

    @retry(**_RETRY)
    def add_label_to_card(self, *, card_id: str, label_id: str) -> dict[str, Any]:
        url = f"https://api.trello.com/1/cards/{card_id}/idLabels"
        payload = {"value": label_id}
        resp = self._client.post(url, params=self._params(), data=payload)
        raise_for_status_rate_limit(resp)
        return resp.json()

    @retry(**_RETRY)
    def add_comment_to_card(self, *, card_id: str, text: str) -> dict[str, Any]:
        url = f"https://api.trello.com/1/cards/{card_id}/actions/comments"
        payload = {"text": text}
        resp = self._client.post(url, params=self._params(), data=payload)
        raise_for_status_rate_limit(resp)
        return resp.json()

    def add_comment(self, *, card_id: str, text: str) -> dict[str, Any]:
        """Alias for add_comment_to_card (used by newer domain modules)."""
        return self.add_comment_to_card(card_id=card_id, text=text)

    @retry(**_RETRY)
    def add_attachment(self, *, card_id: str, url_to_attach: str, name: str = "") -> dict[str, Any]:
        url = f"https://api.trello.com/1/cards/{card_id}/attachments"
        data: dict[str, str] = {"url": url_to_attach}
        if name:
            data["name"] = name
        resp = self._client.post(url, params=self._params(), data=data)
        raise_for_status_rate_limit(resp)
        return resp.json()

    @retry(**_RETRY)
    def update_card_name(self, *, card_id: str, name: str) -> dict[str, Any]:
        url = f"https://api.trello.com/1/cards/{card_id}"
        resp = self._client.put(url, params=self._params(), data={"name": name})
        raise_for_status_rate_limit(resp)
        return resp.json()

    @retry(**_RETRY)
    def update_card(
        self,
        *,
        card_id: str,
        name: str | None = None,
        desc: str | None = None,
        pos: str | None = None,
        due_complete: bool | None = None,
    ) -> dict[str, Any]:
        data: dict[str, str] = {}
        if name is not None:
            data["name"] = name
        if desc is not None:
            data["desc"] = desc
        if pos is not None:
            data["pos"] = pos  # "top", "bottom", or float
        if due_complete is not None:
            data["dueComplete"] = "true" if due_complete else "false"
        url = f"https://api.trello.com/1/cards/{card_id}"
        resp = self._client.put(url, params=self._params(), data=data)
        raise_for_status_rate_limit(resp)
        return resp.json()

    @retry(**_RETRY)
    def get_cards_in_list(self, *, list_id: str) -> list[dict[str, Any]]:
        url = f"https://api.trello.com/1/lists/{list_id}/cards"
        resp = self._client.get(url, params=self._params())
        raise_for_status_rate_limit(resp)
        return resp.json()

    @retry(**_RETRY)
    def get_board_cards(self, *, board_id: str) -> list[dict[str, Any]]:
        url = f"https://api.trello.com/1/boards/{board_id}/cards"
        resp = self._client.get(url, params=self._params())
        raise_for_status_rate_limit(resp)
        return resp.json()

    @retry(**_RETRY)
    def get_checklists(self, *, card_id: str) -> list[dict[str, Any]]:
        url = f"https://api.trello.com/1/cards/{card_id}/checklists"
        resp = self._client.get(url, params=self._params())
        raise_for_status_rate_limit(resp)
        return resp.json()

    @retry(**_RETRY)
    def create_checklist(self, *, card_id: str, name: str) -> dict[str, Any]:
        url = f"https://api.trello.com/1/cards/{card_id}/checklists"
        resp = self._client.post(url, params=self._params(), data={"name": name})
        raise_for_status_rate_limit(resp)
        return resp.json()

    @retry(**_RETRY)
    def add_checklist_item(self, *, checklist_id: str, name: str) -> dict[str, Any]:
        url = f"https://api.trello.com/1/checklists/{checklist_id}/checkItems"
        resp = self._client.post(url, params=self._params(), data={"name": name})
        raise_for_status_rate_limit(resp)
        return resp.json()

    @retry(**_RETRY)
    def update_checklist_item(
        self,
        *,
        card_id: str,
        checkitem_id: str,
        name: str | None = None,
        state: str | None = None,
    ) -> dict[str, Any]:
        data: dict[str, str] = {}
        if name is not None:
            data["name"] = name
        if state is not None:
            data["state"] = state  # "complete" | "incomplete"
        url = f"https://api.trello.com/1/cards/{card_id}/checkItem/{checkitem_id}"
        resp = self._client.put(url, params=self._params(), data=data)
        raise_for_status_rate_limit(resp)
        return resp.json()

    def standard_lists(self) -> list[str]:
        return [
            "Requests",
            "In Progress",
            "Needs Review / Feedback",
            "Approved / Ready for Delivery",
            "Published / Delivered",
            "Reference & Links",
        ]
