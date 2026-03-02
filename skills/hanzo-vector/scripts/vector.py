#!/usr/bin/env python3
"""Hanzo Vector CLI -- manage collections and perform vector operations.

Usage:
    python3 vector.py <command> [options]

Commands:
    collection create  Create a new collection
    collection list    List all collections
    collection info    Get collection details
    collection delete  Delete a collection
    upsert             Upsert points into a collection
    search             Search by vector similarity
    get                Get points by ID
    delete             Delete points by ID
    count              Count points in a collection

Common Options:
    --host       Qdrant host (default: $HANZO_VECTOR_HOST or https://vector.hanzo.ai)
    --port       Qdrant port (only needed for non-standard ports; HTTPS uses 443 by default)
    --api-key    API key (default: $HANZO_API_KEY)
    --format     Output format: text, json (default: text)
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error


def resolve_base_url(args: argparse.Namespace) -> str:
    host = args.host or os.environ.get("HANZO_VECTOR_HOST", "https://vector.hanzo.ai")
    port = args.port or os.environ.get("HANZO_VECTOR_PORT", "")
    host = host.rstrip("/")

    # Only append a port if explicitly provided. HTTPS uses standard port 443
    # via K8s ingress, so no port suffix is needed by default.
    hostname_part = host.split("//")[-1]
    has_explicit_port = ":" in hostname_part
    if port and not has_explicit_port:
        host = f"{host}:{port}"

    return host


def resolve_api_key(args: argparse.Namespace) -> str:
    key = args.api_key or os.environ.get("HANZO_API_KEY", "")
    if not key:
        print("Error: No API key provided. Set HANZO_API_KEY or use --api-key.", file=sys.stderr)
        sys.exit(1)
    return key


def qdrant_request(base_url: str, api_key: str, method: str, path: str,
                   body: dict | None = None, timeout: int = 30) -> dict:
    url = f"{base_url}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None

    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "hanzo-bot/1.0",
            "api-key": api_key,
        },
        method=method,
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        print(f"Error: HTTP {e.code} from Qdrant", file=sys.stderr)
        if error_body:
            print(error_body[:500], file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Error: Failed to connect to Qdrant: {e.reason}", file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Collection commands
# ---------------------------------------------------------------------------

def cmd_collection_create(args: argparse.Namespace) -> None:
    base_url = resolve_base_url(args)
    api_key = resolve_api_key(args)

    distance_map = {
        "cosine": "Cosine",
        "euclid": "Euclid",
        "dot": "Dot",
    }
    distance = distance_map.get(args.distance.lower(), "Cosine")

    body = {
        "vectors": {
            "size": args.dimension,
            "distance": distance,
        }
    }
    result = qdrant_request(base_url, api_key, "PUT",
                            f"/collections/{args.name}", body)

    if args.format == "json":
        print(json.dumps(result, indent=2))
    else:
        status = result.get("result", result.get("status", "unknown"))
        print(f"Collection '{args.name}' created (status: {status})")


def cmd_collection_list(args: argparse.Namespace) -> None:
    base_url = resolve_base_url(args)
    api_key = resolve_api_key(args)

    result = qdrant_request(base_url, api_key, "GET", "/collections")

    if args.format == "json":
        print(json.dumps(result, indent=2))
    else:
        collections = result.get("result", {}).get("collections", [])
        if not collections:
            print("No collections found.")
            return
        print(f"Collections ({len(collections)}):")
        for col in collections:
            name = col.get("name", "unknown")
            print(f"  - {name}")


def cmd_collection_info(args: argparse.Namespace) -> None:
    base_url = resolve_base_url(args)
    api_key = resolve_api_key(args)

    result = qdrant_request(base_url, api_key, "GET",
                            f"/collections/{args.name}")

    if args.format == "json":
        print(json.dumps(result, indent=2))
    else:
        info = result.get("result", {})
        status = info.get("status", "unknown")
        points = info.get("points_count", 0)
        vectors = info.get("vectors_count", 0)
        segments = info.get("segments_count", 0)
        config = info.get("config", {}).get("params", {}).get("vectors", {})
        dim = config.get("size", "?")
        dist = config.get("distance", "?")

        print(f"Collection: {args.name}")
        print(f"Status: {status}")
        print(f"Points: {points}")
        print(f"Vectors: {vectors}")
        print(f"Segments: {segments}")
        print(f"Dimension: {dim}")
        print(f"Distance: {dist}")


def cmd_collection_delete(args: argparse.Namespace) -> None:
    base_url = resolve_base_url(args)
    api_key = resolve_api_key(args)

    result = qdrant_request(base_url, api_key, "DELETE",
                            f"/collections/{args.name}")

    if args.format == "json":
        print(json.dumps(result, indent=2))
    else:
        status = result.get("result", result.get("status", "unknown"))
        print(f"Collection '{args.name}' deleted (status: {status})")


# ---------------------------------------------------------------------------
# Point commands
# ---------------------------------------------------------------------------

def cmd_upsert(args: argparse.Namespace) -> None:
    base_url = resolve_base_url(args)
    api_key = resolve_api_key(args)

    if args.input == "-":
        raw = sys.stdin.read()
    else:
        with open(args.input) as f:
            raw = f.read()

    data = json.loads(raw)
    points = data.get("points", data if isinstance(data, list) else [data])

    body = {"points": points}
    result = qdrant_request(base_url, api_key, "PUT",
                            f"/collections/{args.collection}/points",
                            body, timeout=120)

    if args.format == "json":
        print(json.dumps(result, indent=2))
    else:
        status = result.get("result", {}).get("status", result.get("status", "unknown"))
        print(f"Upserted {len(points)} points into '{args.collection}' (status: {status})")


def cmd_search(args: argparse.Namespace) -> None:
    base_url = resolve_base_url(args)
    api_key = resolve_api_key(args)

    vector = json.loads(args.vector)
    body: dict = {
        "vector": vector,
        "limit": args.limit,
        "with_payload": True,
    }
    if args.filter:
        body["filter"] = json.loads(args.filter)
    if args.score_threshold is not None:
        body["score_threshold"] = args.score_threshold

    result = qdrant_request(base_url, api_key, "POST",
                            f"/collections/{args.collection}/points/search",
                            body)

    if args.format == "json":
        print(json.dumps(result, indent=2))
    else:
        points = result.get("result", [])
        print(f"Search results ({len(points)}):")
        for pt in points:
            pt_id = pt.get("id", "?")
            score = pt.get("score", 0)
            payload = pt.get("payload", {})
            text = payload.get("text", str(payload)[:100])
            print(f"  [{pt_id}] score={score:.4f} {text}")


def cmd_get(args: argparse.Namespace) -> None:
    base_url = resolve_base_url(args)
    api_key = resolve_api_key(args)

    ids = []
    for raw_id in args.ids.split(","):
        raw_id = raw_id.strip()
        if not raw_id:
            continue
        try:
            ids.append(int(raw_id))
        except ValueError:
            ids.append(raw_id)

    body = {"ids": ids, "with_payload": True, "with_vector": args.with_vector}
    result = qdrant_request(base_url, api_key, "POST",
                            f"/collections/{args.collection}/points",
                            body)

    if args.format == "json":
        print(json.dumps(result, indent=2))
    else:
        points = result.get("result", [])
        print(f"Points ({len(points)}):")
        for pt in points:
            pt_id = pt.get("id", "?")
            payload = pt.get("payload", {})
            print(f"  [{pt_id}] {json.dumps(payload)[:200]}")


def cmd_delete_points(args: argparse.Namespace) -> None:
    base_url = resolve_base_url(args)
    api_key = resolve_api_key(args)

    ids = []
    for raw_id in args.ids.split(","):
        raw_id = raw_id.strip()
        if not raw_id:
            continue
        try:
            ids.append(int(raw_id))
        except ValueError:
            ids.append(raw_id)

    body = {"points": ids}
    result = qdrant_request(base_url, api_key, "POST",
                            f"/collections/{args.collection}/points/delete",
                            body)

    if args.format == "json":
        print(json.dumps(result, indent=2))
    else:
        status = result.get("result", {}).get("status", result.get("status", "unknown"))
        print(f"Deleted {len(ids)} points from '{args.collection}' (status: {status})")


def cmd_count(args: argparse.Namespace) -> None:
    base_url = resolve_base_url(args)
    api_key = resolve_api_key(args)

    body: dict = {"exact": args.exact}
    result = qdrant_request(base_url, api_key, "POST",
                            f"/collections/{args.collection}/points/count",
                            body)

    if args.format == "json":
        print(json.dumps(result, indent=2))
    else:
        count = result.get("result", {}).get("count", 0)
        print(f"Collection '{args.collection}': {count} points")


# ---------------------------------------------------------------------------
# Argument parser
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Hanzo Vector CLI")
    parser.add_argument("--host", default=None, help="Qdrant host")
    parser.add_argument("--port", default=None,
                        help="Qdrant port (only for non-standard ports; HTTPS uses 443)")
    parser.add_argument("--api-key", default=None, help="API key")
    parser.add_argument("--format", default="text", choices=["text", "json"],
                        help="Output format")

    subparsers = parser.add_subparsers(dest="command", required=True)

    # --- collection ---
    col_parser = subparsers.add_parser("collection", help="Collection management")
    col_sub = col_parser.add_subparsers(dest="col_action", required=True)

    create_p = col_sub.add_parser("create", help="Create a collection")
    create_p.add_argument("--name", required=True, help="Collection name")
    create_p.add_argument("--dimension", type=int, required=True, help="Vector dimension")
    create_p.add_argument("--distance", default="cosine",
                          choices=["cosine", "euclid", "dot"],
                          help="Distance metric (default: cosine)")

    col_sub.add_parser("list", help="List collections")

    info_p = col_sub.add_parser("info", help="Collection info")
    info_p.add_argument("--name", required=True, help="Collection name")

    del_col_p = col_sub.add_parser("delete", help="Delete a collection")
    del_col_p.add_argument("--name", required=True, help="Collection name")

    # --- upsert ---
    upsert_p = subparsers.add_parser("upsert", help="Upsert points")
    upsert_p.add_argument("--collection", required=True, help="Collection name")
    upsert_p.add_argument("--input", required=True, help="JSON file or - for stdin")

    # --- search ---
    search_p = subparsers.add_parser("search", help="Search by vector")
    search_p.add_argument("--collection", required=True, help="Collection name")
    search_p.add_argument("--vector", required=True, help="Query vector as JSON array")
    search_p.add_argument("--limit", type=int, default=10, help="Max results")
    search_p.add_argument("--filter", default=None, help="JSON filter")
    search_p.add_argument("--score-threshold", type=float, default=None,
                          help="Minimum score threshold")

    # --- get ---
    get_p = subparsers.add_parser("get", help="Get points by ID")
    get_p.add_argument("--collection", required=True, help="Collection name")
    get_p.add_argument("--ids", required=True, help="Comma-separated point IDs")
    get_p.add_argument("--with-vector", action="store_true",
                       help="Include vectors in response")

    # --- delete ---
    del_p = subparsers.add_parser("delete", help="Delete points by ID")
    del_p.add_argument("--collection", required=True, help="Collection name")
    del_p.add_argument("--ids", required=True, help="Comma-separated point IDs")

    # --- count ---
    count_p = subparsers.add_parser("count", help="Count points")
    count_p.add_argument("--collection", required=True, help="Collection name")
    count_p.add_argument("--exact", action="store_true",
                         help="Exact count (slower)")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    command = args.command

    if command == "collection":
        action = args.col_action
        if action == "create":
            cmd_collection_create(args)
        elif action == "list":
            cmd_collection_list(args)
        elif action == "info":
            cmd_collection_info(args)
        elif action == "delete":
            cmd_collection_delete(args)
    elif command == "upsert":
        cmd_upsert(args)
    elif command == "search":
        cmd_search(args)
    elif command == "get":
        cmd_get(args)
    elif command == "delete":
        cmd_delete_points(args)
    elif command == "count":
        cmd_count(args)


if __name__ == "__main__":
    main()
