#!/usr/bin/env python3
"""
Export FBref (Sports Reference) tables to CSV via the soccerdata library.

Requires: pip install -r requirements-fbref.txt

Respect Sports Reference / FBref terms of use; use for research only; attribute the source.
Full match-level exports can be extremely large — use --depth and narrow --season-range when testing.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path


def _season_codes_from_year_range(y0: int, y1: int) -> list[str]:
    """soccerdata accepts '1718', '1819', ... style codes."""
    lo, hi = min(y0, y1), max(y0, y1)
    out: list[str] = []
    for y in range(lo, hi + 1):
        a, b = y % 100, (y + 1) % 100
        out.append(f"{a:02d}{b:02d}")
    return out


TEAM_SEASON_TYPES = [
    "standard",
    "keeper",
    "keeper_adv",
    "shooting",
    "passing",
    "passing_types",
    "goal_shot_creation",
    "defense",
    "possession",
    "playing_time",
    "misc",
]

PLAYER_SEASON_TYPES = [
    "standard",
    "shooting",
    "passing",
    "passing_types",
    "goal_shot_creation",
    "defense",
    "possession",
    "playing_time",
    "misc",
    "keeper",
    "keeper_adv",
]

TEAM_MATCH_TYPES = [
    "schedule",
    "keeper",
    "shooting",
    "passing",
    "passing_types",
    "goal_shot_creation",
    "defense",
    "possession",
    "misc",
]

PLAYER_MATCH_TYPES = [
    "summary",
    "keepers",
    "passing",
    "passing_types",
    "defense",
    "possession",
    "misc",
]


def _resolve_leagues(preset: str | None, leagues_csv: str | None, sd) -> list[str]:
    if leagues_csv and leagues_csv.strip().upper() == "ALL":
        return list(sd.FBref.available_leagues())

    if leagues_csv:
        return [s.strip() for s in leagues_csv.split(",") if s.strip()]

    p = (preset or "big5").strip().lower()
    if p == "all":
        return list(sd.FBref.available_leagues())
    if p == "big5":
        return ["Big 5 European Leagues Combined"]
    presets = {
        "england": ["ENG-Premier League"],
        "spain": ["ESP-La Liga"],
        "italy": ["ITA-Serie A"],
        "germany": ["GER-Bundesliga"],
        "france": ["FRA-Ligue 1"],
        "scotland": ["SCO-Premiership"],
        "usa": ["USA-Major League Soccer"],
    }
    if p in presets:
        return presets[p]
    raise SystemExit(f"Unknown --preset {preset!r}. Try: all, big5, england, spain, italy, germany, france, scotland, usa")


def _resolve_seasons(args: argparse.Namespace) -> list[str]:
    if args.seasons:
        return [s.strip() for s in args.seasons.split(",") if s.strip()]
    if args.season_range:
        parts = args.season_range.split("-", 1)
        if len(parts) != 2:
            raise SystemExit("--season-range must look like 1993-2025")
        a, b = int(parts[0].strip()), int(parts[1].strip())
        return _season_codes_from_year_range(a, b)
    if args.season:
        return [args.season.strip()]
    y = datetime.now().year
    return _season_codes_from_year_range(y - 10, y)


def _resolve_proxy(cli_value: str | None) -> str | None:
    """soccerdata accepts a proxy URL string (http://, socks5://, …)."""
    if cli_value and str(cli_value).strip():
        return str(cli_value).strip()
    for key in (
        "FBREF_PROXY",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ):
        v = os.environ.get(key)
        if v and v.strip():
            return v.strip()
    return None


def main() -> None:
    ap = argparse.ArgumentParser(description="Export FBref data to CSV (soccerdata).")
    ap.add_argument("--out", required=True, help="Output directory")
    ap.add_argument("--preset", default="big5", help="all|big5|england|spain|italy|germany|france|scotland|usa")
    ap.add_argument("--leagues", default=None, help="Comma-separated league IDs, or ALL")
    ap.add_argument("--season-range", dest="season_range", default=None)
    ap.add_argument("--season", default=None)
    ap.add_argument("--seasons", default=None, help="Comma season codes e.g. 2324,2425")
    ap.add_argument(
        "--depth",
        choices=("core", "extended", "full"),
        default="core",
        help="core=schedule+team/player season aggregates; extended=+team match tables; full=+player match tables (huge)",
    )
    ap.add_argument("--delay-ms", type=int, default=400)
    ap.add_argument(
        "--proxy",
        default=None,
        help="Proxy URL for soccerdata (e.g. http://127.0.0.1:7890). Overrides env FBREF_PROXY / HTTPS_PROXY / ALL_PROXY.",
    )
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    try:
        import soccerdata as sd
    except ImportError:
        print(
            "Missing dependency: pip install soccerdata pandas\n"
            "See skills/football-local-data/requirements-fbref.txt",
            file=sys.stderr,
        )
        if args.dry_run:
            print(
                json.dumps(
                    {
                        "dryRun": True,
                        "error": "soccerdata not installed",
                        "hint": "pip install -r skills/football-local-data/requirements-fbref.txt",
                    },
                    indent=2,
                ),
            )
            return
        sys.exit(1)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    leagues = _resolve_leagues(args.preset, args.leagues, sd)
    seasons = _resolve_seasons(args)

    manifest = {
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "fbref (via soccerdata)",
        "notesUrl": "https://fbref.com/",
        "leagues": leagues,
        "seasons": seasons,
        "depth": args.depth,
        "manifestStatus": "pending",
        "files": [],
    }

    proxy = _resolve_proxy(args.proxy)
    if proxy:
        manifest["proxyEnabled"] = True

    if args.dry_run:
        manifest["dryRun"] = True
        print(json.dumps(manifest, indent=2))
        return

    cache_dir = out / "_soccerdata_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = out / "manifest.json"

    def write_manifest() -> None:
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    fb = sd.FBref(leagues=leagues, seasons=seasons, data_dir=cache_dir, proxy=proxy)

    manifest["manifestStatus"] = "in_progress"
    write_manifest()

    def pause() -> None:
        if args.delay_ms > 0:
            time.sleep(args.delay_ms / 1000.0)

    def save_df(name: str, df) -> None:
        path = out / f"{name}.csv"
        df.to_csv(path, index=True)
        manifest["files"].append({"name": f"{name}.csv", "rows": int(len(df))})
        write_manifest()
        pause()

    # Schedule (all games in selection)
    try:
        sched = fb.read_schedule()
        save_df("schedule", sched)
    except Exception as e:
        manifest["files"].append({"name": "schedule.csv", "error": str(e)})
        write_manifest()

    for st in TEAM_SEASON_TYPES:
        try:
            df = fb.read_team_season_stats(stat_type=st)
            save_df(f"team_season_{st}", df)
        except Exception as e:
            manifest["files"].append({"name": f"team_season_{st}.csv", "error": str(e)})
            write_manifest()

    for st in PLAYER_SEASON_TYPES:
        try:
            df = fb.read_player_season_stats(stat_type=st)
            save_df(f"player_season_{st}", df)
        except Exception as e:
            manifest["files"].append({"name": f"player_season_{st}.csv", "error": str(e)})
            write_manifest()

    if args.depth in ("extended", "full"):
        for st in TEAM_MATCH_TYPES:
            try:
                df = fb.read_team_match_stats(stat_type=st)
                save_df(f"team_match_{st}", df)
            except Exception as e:
                manifest["files"].append({"name": f"team_match_{st}.csv", "error": str(e)})
                write_manifest()

    if args.depth == "full":
        for st in PLAYER_MATCH_TYPES:
            try:
                df = fb.read_player_match_stats(stat_type=st)
                save_df(f"player_match_{st}", df)
            except Exception as e:
                manifest["files"].append({"name": f"player_match_{st}.csv", "error": str(e)})
                write_manifest()

    manifest["manifestStatus"] = "complete"
    manifest["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    write_manifest()
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
