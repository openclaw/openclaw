"""
bodhi_viz.export — Export vault data to visualization-ready JSON.

Generates two files in ~/.openclaw/viz/:
  graph.json   — nodes + links for 3D force-physics graph
  sankey.json  — domain → type → energy tier flow counts

Usage:
  python -m bodhi_viz.export
  python -m bodhi_viz.export --vault /custom/vault/path
"""

import argparse
import json
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

VAULT_PATH = Path(os.path.expanduser("~/openbodhi/vault"))
VIZ_DIR = Path(os.path.expanduser("~/.openclaw/viz"))

DOMAIN_COLORS = {
    "wellness": "#4ade80",
    "fitness": "#60a5fa",
    "health": "#f97316",
    "mental-health": "#c084fc",
    "cognitive": "#facc15",
}

TIER_COLORS = {
    "High": "#f59e0b",
    "Medium": "#818cf8",
    "Low": "#64748b",
}


def _energy_tier(level: int) -> str:
    if level >= 4:
        return "High"
    elif level == 3:
        return "Medium"
    return "Low"


def build_graph(nodes: list[dict[str, Any]]) -> dict[str, Any]:
    """Build nodes + links for 3D force-physics knowledge graph."""
    graph_nodes = []
    graph_links = []

    for node in nodes:
        domain = node.get("domain") or "unknown"
        energy = node.get("energy_level", 1)
        content = node.get("content", "")
        preview = content[:120] + "..." if len(content) > 120 else content

        graph_nodes.append({
            "id": node["id"],
            "label": preview[:60] if preview else node["id"][:20],
            "val": max(2, energy * 3),
            "group": domain,
            "color": DOMAIN_COLORS.get(domain, "#94a3b8"),
            "created_at": node.get("created_at", ""),
            "type": node.get("type", "Unknown"),
            "tags": node.get("tags", []),
            "people": node.get("people", []),
            "cluster_id": node.get("cluster_id"),
            "energy_level": energy,
            "content": content,
            "content_enriched": node.get("content_enriched", ""),
            "domain": domain,
            "media_type": node.get("media_type", "text"),
        })

    # Links from shared people[]
    people_to_nodes: dict[str, list[str]] = defaultdict(list)
    for node in nodes:
        for person in node.get("people", []):
            if person:
                people_to_nodes[person].append(node["id"])

    for person, ids in people_to_nodes.items():
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                graph_links.append({
                    "source": ids[i],
                    "target": ids[j],
                    "type": "person",
                    "label": person,
                    "color": "rgba(250,204,21,0.4)",
                })

    # Links from shared cluster_id — star topology (hub + spokes), not full mesh
    cluster_to_nodes: dict[str, list[str]] = defaultdict(list)
    for node in nodes:
        cluster = node.get("cluster_id")
        if cluster:
            cluster_to_nodes[cluster].append(node["id"])

    for cluster, ids in cluster_to_nodes.items():
        hub = ids[0]  # First node is the hub; avoids O(n²) intra-cluster links
        for spoke in ids[1:]:
            graph_links.append({
                "source": hub,
                "target": spoke,
                "type": "cluster",
                "label": f"cluster:{cluster[:8]}",
                "color": "rgba(148,163,184,0.3)",
            })

    # Links from tag affinity (>=3 shared tags, max 15 per node to cap density)
    TAG_THRESHOLD = 3
    MAX_TAG_LINKS_PER_NODE = 15

    node_tags: dict[str, set] = {
        n["id"]: set(t for t in n.get("tags", []) if t) for n in nodes
    }
    node_ids = list(node_tags.keys())
    tag_link_counts: dict[str, int] = defaultdict(int)
    for i in range(len(node_ids)):
        for j in range(i + 1, len(node_ids)):
            a, b = node_ids[i], node_ids[j]
            if tag_link_counts[a] >= MAX_TAG_LINKS_PER_NODE:
                continue
            if tag_link_counts[b] >= MAX_TAG_LINKS_PER_NODE:
                continue
            shared = node_tags[a] & node_tags[b]
            if len(shared) >= TAG_THRESHOLD:
                graph_links.append({
                    "source": a,
                    "target": b,
                    "type": "tag",
                    "label": ", ".join(sorted(shared)[:3]),
                    "color": "rgba(192,132,252,0.25)",
                })
                tag_link_counts[a] += 1
                tag_link_counts[b] += 1

    return {"nodes": graph_nodes, "links": graph_links}


def build_sankey(nodes: list[dict[str, Any]]) -> dict[str, Any]:
    """Build domain → type → energy tier flows for Sankey diagram."""
    sankey_nodes: list[dict] = []
    node_index: dict[str, int] = {}

    domains = sorted(set(n.get("domain") or "unknown" for n in nodes))
    types = sorted(set(n.get("type") or "Unknown" for n in nodes))
    tiers = ["High", "Medium", "Low"]

    for d in domains:
        idx = len(sankey_nodes)
        node_index[f"domain:{d}"] = idx
        sankey_nodes.append({
            "id": idx,
            "name": d.replace("-", " ").title(),
            "color": DOMAIN_COLORS.get(d, "#94a3b8"),
            "layer": "domain",
        })

    for t in types:
        idx = len(sankey_nodes)
        node_index[f"type:{t}"] = idx
        sankey_nodes.append({
            "id": idx,
            "name": t or "Unknown",
            "color": "#334155",
            "layer": "type",
        })

    for tier in tiers:
        idx = len(sankey_nodes)
        node_index[f"tier:{tier}"] = idx
        sankey_nodes.append({
            "id": idx,
            "name": f"{tier} Energy",
            "color": TIER_COLORS[tier],
            "layer": "tier",
        })

    flow_dt: dict[tuple, int] = defaultdict(int)
    flow_te: dict[tuple, int] = defaultdict(int)

    for n in nodes:
        d = n.get("domain") or "unknown"
        t = n.get("type") or "Unknown"
        tier = _energy_tier(n.get("energy_level", 1))
        flow_dt[(d, t)] += 1
        flow_te[(t, tier)] += 1

    sankey_links = []
    for (d, t), count in flow_dt.items():
        src_key = f"domain:{d}"
        tgt_key = f"type:{t}"
        if src_key in node_index and tgt_key in node_index:
            sankey_links.append({
                "source": node_index[src_key],
                "target": node_index[tgt_key],
                "value": count,
            })

    for (t, tier), count in flow_te.items():
        src_key = f"type:{t}"
        tgt_key = f"tier:{tier}"
        if src_key in node_index and tgt_key in node_index:
            sankey_links.append({
                "source": node_index[src_key],
                "target": node_index[tgt_key],
                "value": count,
            })

    return {"nodes": sankey_nodes, "links": sankey_links}


def _fallback_query(vault_path: Path) -> list[dict]:
    """Inline query if bodhi_vault not importable."""
    nodes_dir = vault_path / "nodes"
    results = []
    if not nodes_dir.exists():
        return results
    for f in nodes_dir.rglob("*.json"):
        try:
            results.append(json.loads(Path(f).read_text(encoding="utf-8")))
        except Exception:
            pass
    return results


def export(
    vault_path: Path = VAULT_PATH,
    viz_dir: Path = VIZ_DIR,
) -> dict[str, Any]:
    """
    Run full export. Returns dict with paths + stats.

    Returns:
        {
            "graph": Path,
            "sankey": Path,
            "node_count": int,
            "link_count": int,
        }
    """
    try:
        # Add vault package to path if needed
        vault_pkg = Path(__file__).parent.parent / "bodhi_vault" / "src"
        if vault_pkg.exists() and str(vault_pkg) not in sys.path:
            sys.path.insert(0, str(vault_pkg))
        from bodhi_vault.read import query_nodes
        nodes = query_nodes(vault_path)
    except ImportError:
        nodes = _fallback_query(vault_path)

    viz_dir.mkdir(parents=True, exist_ok=True)

    graph_data = build_graph(nodes)
    sankey_data = build_sankey(nodes)

    graph_path = viz_dir / "graph.json"
    sankey_path = viz_dir / "sankey.json"

    # Atomic writes
    for data, path in [(graph_data, graph_path), (sankey_data, sankey_path)]:
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)

    return {
        "graph": graph_path,
        "sankey": sankey_path,
        "node_count": len(nodes),
        "link_count": len(graph_data["links"]),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Export vault to visualization JSON")
    parser.add_argument("--vault", type=Path, default=VAULT_PATH)
    parser.add_argument("--out", type=Path, default=VIZ_DIR)
    args = parser.parse_args()

    result = export(vault_path=args.vault, viz_dir=args.out)
    print(f"Exported {result['node_count']} nodes, {result['link_count']} links")
    print(f"  graph.json  → {result['graph']}")
    print(f"  sankey.json → {result['sankey']}")


if __name__ == "__main__":
    main()
