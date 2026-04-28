#!/usr/bin/env python3

import argparse
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def format_timestamp(value: str, timezone_name: str) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.astimezone(ZoneInfo(timezone_name)).strftime("%Y-%m-%d %H:%M")


def render_count_lines(items: list[dict], empty_message: str) -> list[str]:
    if not items:
        return [f"- {empty_message}"]
    return [f"- {item['name']}: {item['count']}" for item in items]


def infer_notes(snapshot: dict) -> list[str]:
    notes = [f"Selection count: {snapshot['selection']['count']}"]

    top_tags = snapshot.get("summaryHints", {}).get("topTags", [])
    tag_names = {item["name"].lower() for item in top_tags}
    if {"furniture", "walls"} & tag_names:
        notes.append("Model appears office/interior-heavy")

    top_definitions = snapshot.get("summaryHints", {}).get("topDefinitions", [])
    if any("window" in item["name"].lower() for item in top_definitions):
        notes.append("Facade/window repetition suggests reusable architectural components")

    warnings = snapshot.get("summaryHints", {}).get("warnings", [])
    notes.extend(warnings)
    return notes


def generate_markdown(snapshot: dict, timezone_name: str) -> str:
    summary_hints = snapshot.get("summaryHints", {})
    source = snapshot["source"]
    model = snapshot["model"]

    lines = [
        "# SketchUp Model Summary",
        "",
        "## Source",
        f"- File: {source['documentName']}",
        f"- Captured: {format_timestamp(source['capturedAt'], timezone_name)}",
        f"- Read-only: {'yes' if source['readOnly'] else 'no'}",
        "",
        "## Model Overview",
        f"- Scenes: {model['sceneCount']}",
        f"- Tags: {model['tagCount']}",
        f"- Materials: {model['materialCount']}",
        f"- Component instances: {model['componentInstanceCount']}",
        f"- Groups: {model['groupCount']}",
        f"- Total entities: {model['entityCount']}",
        "",
        "## Most Common Tags",
    ]

    lines.extend(render_count_lines(summary_hints.get("topTags", []), "No tag frequency hints"))
    lines.extend(["", "## Most Reused Components"])
    lines.extend(render_count_lines(summary_hints.get("topDefinitions", []), "No component reuse hints"))
    lines.extend(["", "## Notes"])
    lines.extend(f"- {note}" for note in infer_notes(snapshot))
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate a markdown summary from a snapshot JSON.")
    parser.add_argument(
        "--input",
        default="samples/sample-model-snapshot.json",
        help="Path to the snapshot JSON.",
    )
    parser.add_argument(
        "--output",
        default="-",
        help="Output markdown path, or '-' for stdout.",
    )
    parser.add_argument(
        "--timezone",
        default="Europe/Istanbul",
        help="IANA timezone used for the rendered capture timestamp.",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    input_path = (repo_root / args.input).resolve()
    snapshot = load_json(input_path)
    markdown = generate_markdown(snapshot, args.timezone)

    if args.output == "-":
        print(markdown, end="")
    else:
        output_path = Path(args.output)
        if not output_path.is_absolute():
            output_path = (repo_root / output_path).resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(markdown, encoding="utf-8")
        print(f"WROTE {output_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
