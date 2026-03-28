from __future__ import annotations

from scripts.memory_hub.index_db import get_source_bindings, search_memories


def route_query_type(query_type: str) -> dict:
    if query_type in {"长期偏好", "协作规则", "跨项目历史", "跨端延续"}:
        return {"primary": "central", "needs_source_bindings": True}
    if query_type in {"当前项目状态", "近期流水"}:
        return {"primary": "local", "needs_source_bindings": False}
    return {"primary": "local_then_central", "needs_source_bindings": True}


def retrieve(db_path, query_type: str, query: str) -> dict:
    route = route_query_type(query_type)
    central_hits = search_memories(db_path, query) if route["primary"] != "local" else []
    if route.get("needs_source_bindings"):
        for hit in central_hits:
            hit["source_bindings"] = get_source_bindings(db_path, hit["memory_id"])
    return {
        "query_type": query_type,
        "route": route,
        "central_hits": central_hits,
    }
