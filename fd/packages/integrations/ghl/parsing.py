from __future__ import annotations

from typing import Any


def extract_custom_field(contact: dict[str, Any], key: str) -> str | None:
    """
    GHL custom fields are not consistent across accounts.

    We support common shapes:
    1) contact["customField"] as dict: {key: value}
    2) contact["customFields"] as dict: {key: value}
    3) contact["customFields"] as list: [{"key": "...", "value": "..."}, ...]
    4) contact["customField"] as list: [{"id"/"key"/"name": "...", "value": "..."}]
    """
    if not key:
        return None

    # 1) customField dict
    cf = contact.get("customField")
    if isinstance(cf, dict) and key in cf:
        v = cf.get(key)
        return str(v) if v is not None and str(v).strip() else None

    # 2) customFields dict
    cfs = contact.get("customFields")
    if isinstance(cfs, dict) and key in cfs:
        v = cfs.get(key)
        return str(v) if v is not None and str(v).strip() else None

    # 3/4) list shapes
    for field_list in (cf, cfs):
        if isinstance(field_list, list):
            for item in field_list:
                if not isinstance(item, dict):
                    continue
                item_key = item.get("key") or item.get("name") or item.get("id")
                if str(item_key) == key:
                    v = item.get("value")
                    return str(v) if v is not None and str(v).strip() else None

    return None
