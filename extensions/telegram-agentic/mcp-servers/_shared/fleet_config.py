"""Fleet node definitions and Tailscale IP registry."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class FleetNode:
    name: str
    tailscale_ip: str
    user: str
    roles: list[str]
    active: bool = True


# Fleet topology — matches infra/ansible/inventory/hosts.yml
FLEET_NODES: dict[str, FleetNode] = {
    "gateway": FleetNode(
        name="Gateway VPS",
        tailscale_ip="100.69.32.10",
        user="appbox",
        roles=["web", "production", "gateway", "archon"],
    ),
    "kubuntu": FleetNode(
        name="Kubuntu",
        tailscale_ip="100.93.214.109",
        user="jeff",
        roles=["gpu", "brain", "ollama"],
    ),
    "popos": FleetNode(
        name="Pop!_OS",
        tailscale_ip="100.119.126.67",
        user="jeff",
        roles=["utility", "obsidian", "knowledge"],
    ),
    "mac": FleetNode(
        name="Mac",
        tailscale_ip="100.96.154.112",
        user="jeff",
        roles=["dev"],
    ),
    "home": FleetNode(
        name="Home (Old VPS)",
        tailscale_ip="100.85.159.3",
        user="jeff",
        roles=[],
        active=False,  # Decommissioned 2026-03-22
    ),
}


def get_active_nodes() -> dict[str, FleetNode]:
    """Return only active fleet nodes."""
    return {k: v for k, v in FLEET_NODES.items() if v.active}


def get_node(name: str) -> FleetNode | None:
    """Look up a fleet node by name (case-insensitive)."""
    return FLEET_NODES.get(name.lower())
