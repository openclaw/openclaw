from __future__ import annotations

from typing import Any

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential_jitter

from packages.common.config import settings


class GHLClient:
    def __init__(self, api_key: str | None = None, base_url: str | None = None) -> None:
        self.api_key = api_key or settings.GHL_API_KEY
        self.base_url = base_url or settings.GHL_BASE_URL
        self._client = httpx.Client(timeout=20.0)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    @retry(
        reraise=True,
        stop=stop_after_attempt(5),
        wait=wait_exponential_jitter(initial=1, max=10),
        retry=retry_if_exception_type(httpx.HTTPError),
    )
    def upsert_contact(self, payload: dict[str, Any]) -> dict[str, Any]:
        # NOTE: GHL endpoints vary by account/config; this is a placeholder shape.
        # Claude Code can refine based on the exact endpoint you use.
        url = f"{self.base_url}/v1/contacts/"
        resp = self._client.post(url, headers=self._headers(), json=payload)
        resp.raise_for_status()
        return resp.json()

    @retry(
        reraise=True,
        stop=stop_after_attempt(5),
        wait=wait_exponential_jitter(initial=1, max=10),
        retry=retry_if_exception_type(httpx.HTTPError),
    )
    def set_opportunity_stage(self, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}/v1/opportunities/"
        resp = self._client.post(url, headers=self._headers(), json=payload)
        resp.raise_for_status()
        return resp.json()

    @retry(
        reraise=True,
        stop=stop_after_attempt(5),
        wait=wait_exponential_jitter(initial=1, max=10),
        retry=retry_if_exception_type(httpx.HTTPError),
    )
    def update_contact_custom_fields(self, contact_id: str, custom_fields: dict[str, Any]) -> dict[str, Any]:
        # NOTE: GHL endpoints vary by account/config; this is the canonical "request shaping" stub.
        url = f"{self.base_url}/v1/contacts/{contact_id}"
        payload = {"customField": custom_fields}
        resp = self._client.put(url, headers=self._headers(), json=payload)
        resp.raise_for_status()
        return resp.json()

    @retry(
        reraise=True,
        stop=stop_after_attempt(5),
        wait=wait_exponential_jitter(initial=1, max=10),
        retry=retry_if_exception_type(httpx.HTTPError),
    )
    def get_contact(self, contact_id: str) -> dict[str, Any]:
        """
        Canonical request shape:
        GET /v1/contacts/{contact_id}

        NOTE: Some GHL accounts use /contacts/{id} with different versions.
        CloudCode can adjust base_url/path while preserving the contract:
        return JSON with some custom field representation.
        """
        url = f"{self.base_url}/v1/contacts/{contact_id}"
        resp = self._client.get(url, headers=self._headers())
        resp.raise_for_status()
        return resp.json()

    def get_contact_custom_fields_map(self, *, contact_id: str) -> dict[str, Any]:
        """Read contact and return custom fields as a flat {key: value} dict."""
        data = self.get_contact(contact_id=contact_id)
        c = data.get("contact") or data  # tolerant
        cfs = c.get("customFields") or c.get("customfields") or []
        out: dict[str, Any] = {}
        for item in cfs:
            k = item.get("key") or item.get("id") or item.get("fieldKey")
            if k:
                out[str(k)] = item.get("value")
        return out

    @retry(
        reraise=True,
        stop=stop_after_attempt(5),
        wait=wait_exponential_jitter(initial=1, max=10),
        retry=retry_if_exception_type(httpx.HTTPError),
    )
    def search_contacts(
        self,
        *,
        email: str | None = None,
        phone: str | None = None,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        """Search contacts by email or phone."""
        params: dict[str, str | int] = {
            "locationId": settings.GHL_LOCATION_ID,
            "limit": limit,
        }
        if email:
            params["email"] = email
        if phone:
            params["phone"] = phone
        url = f"{self.base_url}/v1/contacts/"
        resp = self._client.get(url, headers=self._headers(), params=params)
        resp.raise_for_status()
        data = resp.json()
        return data.get("contacts") or data.get("data") or []

    @retry(
        reraise=True,
        stop=stop_after_attempt(5),
        wait=wait_exponential_jitter(initial=1, max=10),
        retry=retry_if_exception_type(httpx.HTTPError),
    )
    def update_opportunity_stage(
        self,
        *,
        opportunity_id: str,
        stage: str,
    ) -> dict[str, Any]:
        """Update an opportunity's stage in the pipeline."""
        payload = {"stage": stage, "pipelineId": settings.GHL_PIPELINE_ID}
        url = f"{self.base_url}/v1/opportunities/{opportunity_id}"
        resp = self._client.put(url, headers=self._headers(), json=payload)
        resp.raise_for_status()
        return resp.json()
