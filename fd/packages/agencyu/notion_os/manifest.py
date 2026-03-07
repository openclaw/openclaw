from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class PropertySpec:
    name: str
    type: str
    options: list[str] | None = None
    target_db_key: str | None = None
    required_for_sync: bool = False


@dataclass(frozen=True)
class ViewSpec:
    name: str
    type: str  # table/board/gallery
    group_by: str | None = None
    filter: dict[str, Any] | None = None
    sort: list[str] | None = None


@dataclass(frozen=True)
class DatabaseSpec:
    key: str
    name: str
    primary_title_property: str
    properties: list[PropertySpec]
    required_views: list[ViewSpec]
    required_templates: list[str] | None = None


@dataclass(frozen=True)
class TemplateManifest:
    manifest_version: str
    root_page_title: str
    required_child_pages: list[str]
    databases: list[DatabaseSpec]


def load_manifest_from_json(data: dict[str, Any]) -> TemplateManifest:
    """Parse a manifest JSON dict into typed dataclasses."""
    db_specs: list[DatabaseSpec] = []
    for db in data["databases"]:
        props = []
        for prop_name, spec in db["properties"].items():
            props.append(
                PropertySpec(
                    name=prop_name,
                    type=spec["type"],
                    options=spec.get("options"),
                    target_db_key=spec.get("target_db_key"),
                    required_for_sync=spec.get("required_for_sync", False),
                )
            )
        views = []
        for v in db.get("required_views", []):
            views.append(ViewSpec(
                name=v["name"],
                type=v["type"],
                group_by=v.get("group_by"),
                filter=v.get("filter"),
                sort=v.get("sort"),
            ))
        db_specs.append(
            DatabaseSpec(
                key=db["key"],
                name=db["name"],
                primary_title_property=db["primary_title_property"],
                properties=props,
                required_views=views,
                required_templates=[t["name"] for t in db.get("required_templates", [])] or None,
            )
        )
    return TemplateManifest(
        manifest_version=data["manifest_version"],
        root_page_title=data["workspace"]["root_page_title"],
        required_child_pages=data["workspace"]["required_child_pages"],
        databases=db_specs,
    )
