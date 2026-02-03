#!/usr/bin/env python3
"""
Launch Directories — Submit startups to 40+ launch platforms.

Usage:
    python3 launch.py list [--tier N] [--method M] [--category C]
    python3 launch.py submit <platform> --name "..." --url "..." [options]
    python3 launch.py submit-all --tier N --name "..." --url "..." [options]
    python3 launch.py status [--name "..."]
"""

import argparse
import json
import os
import sys
import webbrowser
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode, quote_plus
from dataclasses import dataclass, asdict
from typing import Optional, List, Dict, Any

# Submission tracking file
SUBMISSIONS_FILE = Path.home() / ".openclaw" / "launch-submissions.json"

@dataclass
class Directory:
    id: str
    name: str
    url: str
    submit_url: str
    method: str  # api, form, browser
    tier: int  # 1-4
    category: str  # general, ai, dev, indie
    env_keys: List[str] = None
    notes: str = ""
    
    def __post_init__(self):
        if self.env_keys is None:
            self.env_keys = []

# Directory database
DIRECTORIES = [
    # Tier 1 — High Impact
    Directory("producthunt", "Product Hunt", "https://producthunt.com", 
              "https://www.producthunt.com/posts/new", "api", 1, "general",
              ["PRODUCTHUNT_TOKEN"], "Schedule Tuesday-Thursday"),
    Directory("hackernews", "Hacker News", "https://news.ycombinator.com",
              "https://news.ycombinator.com/submit", "browser", 1, "general",
              notes="Show HN: [Name] – [Description]"),
    Directory("reddit", "Reddit", "https://reddit.com",
              "https://www.reddit.com/r/SideProject/submit", "api", 1, "general",
              ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_USERNAME", "REDDIT_PASSWORD"],
              "r/SideProject, r/startups, r/SaaS"),
    Directory("indiehackers", "Indie Hackers", "https://indiehackers.com",
              "https://www.indiehackers.com/products/new", "form", 1, "indie"),
    Directory("betalist", "BetaList", "https://betalist.com",
              "https://betalist.com/submit", "api", 1, "general",
              ["BETALIST_TOKEN"], "Pre-launch/beta signups"),
    Directory("devhunt", "Dev Hunt", "https://devhunt.org",
              "https://devhunt.org/submit", "form", 1, "dev"),
    
    # Tier 2 — Solid Directories
    Directory("saashub", "SaaSHub", "https://saashub.com",
              "https://www.saashub.com/submit", "form", 2, "general",
              notes="SaaS alternatives"),
    Directory("uneed", "Uneed", "https://uneed.best",
              "https://uneed.best/submit", "form", 2, "general"),
    Directory("peerlist", "PeerList", "https://peerlist.io",
              "https://peerlist.io/products/submit", "form", 2, "general"),
    Directory("foundrlist", "Foundrlist", "https://foundrlist.com",
              "https://foundrlist.com/submit", "form", 2, "indie"),
    Directory("microlaunch", "Micro Launch", "https://microlaunch.net",
              "https://microlaunch.net/submit", "form", 2, "indie"),
    Directory("directoryhunt", "Directory Hunt", "https://directoryhunt.com",
              "https://directoryhunt.com/submit", "form", 2, "general"),
    
    # Tier 3 — AI-Focused
    Directory("ailaunch", "AI Launch", "https://ailaunch.io",
              "https://ailaunch.io/submit", "form", 3, "ai"),
    Directory("aitoolonline", "AItoolonline", "https://aitoolonline.com",
              "https://aitoolonline.com/submit", "form", 3, "ai"),
    Directory("theresanai", "There's An AI For That", "https://theresanaiforthat.com",
              "https://theresanaiforthat.com/submit/", "form", 3, "ai"),
    Directory("showmebestai", "ShowMeBestAI", "https://showmebestai.com",
              "https://showmebestai.com/submit", "form", 3, "ai"),
    
    # Tier 4 — Niche & Emerging
    Directory("launchigniter", "LaunchIgniter", "https://launchigniter.com",
              "https://launchigniter.com/submit", "form", 4, "general"),
    Directory("fazier", "Fazier", "https://fazier.com",
              "https://fazier.com/submit", "form", 4, "general"),
    Directory("firsto", "Firsto", "https://firsto.io",
              "https://firsto.io/submit", "form", 4, "general"),
    Directory("proofy", "Proofy", "https://proofy.io",
              "https://proofy.io/submit", "form", 4, "general"),
    Directory("shipyard", "ShipYard HQ", "https://shipyardhq.com",
              "https://shipyardhq.com/submit", "form", 4, "indie"),
    Directory("shipsquad", "Shipsquad", "https://shipsquad.com",
              "https://shipsquad.com/submit", "form", 4, "indie"),
    Directory("slocco", "Slocco", "https://slocco.com",
              "https://slocco.com/submit", "form", 4, "general"),
    Directory("stackernews", "Stacker News", "https://stacker.news",
              "https://stacker.news/post", "browser", 4, "general"),
    Directory("tinylaunch", "TinyLaunch", "https://tinylaunch.com",
              "https://tinylaunch.com/submit", "form", 4, "indie"),
    Directory("toolfame", "ToolFame", "https://toolfame.com",
              "https://toolfame.com/submit", "form", 4, "general"),
    Directory("trylaunch", "TryLaunch", "https://trylaunch.com",
              "https://trylaunch.com/submit", "form", 4, "general"),
    Directory("twelvetools", "TwelveTools", "https://twelvetools.com",
              "https://twelvetools.com/submit", "form", 4, "general"),
    Directory("tinystartups", "tinystartups", "https://tinystartups.com",
              "https://tinystartups.com/submit", "form", 4, "indie"),
    Directory("neeed", "neeed directory", "https://neeed.co",
              "https://neeed.co/submit", "form", 4, "general"),
    Directory("turbo0", "turbo0", "https://turbo0.com",
              "https://turbo0.com/submit", "form", 4, "general"),
    Directory("indiedeals", "indie deals", "https://indiedeals.co",
              "https://indiedeals.co/submit", "form", 4, "indie"),
    Directory("indietools", "IndieTools", "https://indietools.io",
              "https://indietools.io/submit", "form", 4, "dev"),
    Directory("saasfame", "SaaSFame", "https://saasfame.com",
              "https://saasfame.com/submit", "form", 4, "general"),
    Directory("launchdubai", "launchdubai", "https://launchdubai.com",
              "https://launchdubai.com/submit", "form", 4, "general"),
    Directory("launchurapp", "launchurapp", "https://launchurapp.com",
              "https://launchurapp.com/submit", "form", 4, "general"),
]

DIRECTORY_MAP = {d.id: d for d in DIRECTORIES}


def load_submissions() -> Dict[str, Any]:
    """Load submission history."""
    if SUBMISSIONS_FILE.exists():
        return json.loads(SUBMISSIONS_FILE.read_text())
    return {"submissions": []}


def save_submission(startup: str, platform: str, status: str, url: str = None):
    """Record a submission."""
    SUBMISSIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    data = load_submissions()
    data["submissions"].append({
        "startup": startup,
        "platform": platform,
        "status": status,
        "url": url,
        "timestamp": datetime.now().isoformat()
    })
    SUBMISSIONS_FILE.write_text(json.dumps(data, indent=2))


def cmd_list(args):
    """List available directories."""
    dirs = DIRECTORIES
    
    if args.tier:
        dirs = [d for d in dirs if d.tier == args.tier]
    if args.method:
        dirs = [d for d in dirs if d.method == args.method]
    if args.category:
        dirs = [d for d in dirs if d.category == args.category]
    
    # Group by tier
    by_tier = {}
    for d in dirs:
        by_tier.setdefault(d.tier, []).append(d)
    
    tier_names = {1: "High Impact", 2: "Solid", 3: "AI-Focused", 4: "Niche & Emerging"}
    
    for tier in sorted(by_tier.keys()):
        print(f"\n## Tier {tier} — {tier_names.get(tier, 'Other')}")
        print(f"{'ID':<16} {'Name':<25} {'Method':<8} {'Notes'}")
        print("-" * 70)
        for d in by_tier[tier]:
            env_info = f"[{', '.join(d.env_keys)}]" if d.env_keys else ""
            notes = d.notes or env_info
            print(f"{d.id:<16} {d.name:<25} {d.method:<8} {notes}")
    
    print(f"\nTotal: {len(dirs)} directories")


def cmd_submit(args):
    """Submit to a single directory."""
    platform_id = args.platform.lower()
    
    if platform_id not in DIRECTORY_MAP:
        print(f"❌ Unknown platform: {args.platform}")
        print(f"Available: {', '.join(sorted(DIRECTORY_MAP.keys()))}")
        sys.exit(1)
    
    directory = DIRECTORY_MAP[platform_id]
    
    # Load data from file if provided
    data = {}
    if args.data:
        data = json.loads(Path(args.data).read_text())
    
    # Override with CLI args
    name = args.name or data.get("name")
    url = args.url or data.get("url")
    tagline = args.tagline or data.get("tagline", "")
    description = args.description or data.get("description", "")
    
    if not name or not url:
        print("❌ --name and --url are required")
        sys.exit(1)
    
    print(f"🚀 Submitting {name} to {directory.name}...")
    
    # Check for required env vars
    missing_env = [k for k in directory.env_keys if not os.environ.get(k)]
    if missing_env and directory.method == "api":
        print(f"⚠️  Missing env vars: {', '.join(missing_env)}")
        print(f"   Falling back to browser method")
        directory = Directory(
            directory.id, directory.name, directory.url,
            directory.submit_url, "browser", directory.tier,
            directory.category, notes=directory.notes
        )
    
    # Handle by method
    if directory.method == "api":
        success = submit_api(directory, name, url, tagline, description, args)
    elif directory.method == "browser":
        success = submit_browser(directory, name, url, tagline, description)
    else:  # form
        success = submit_form(directory, name, url, tagline, description)
    
    if success:
        save_submission(name, platform_id, "submitted", directory.submit_url)
        print(f"✅ Submitted to {directory.name}")
    else:
        save_submission(name, platform_id, "failed")
        print(f"❌ Failed to submit to {directory.name}")


def submit_api(directory: Directory, name: str, url: str, tagline: str, description: str, args) -> bool:
    """Submit via API (platform-specific)."""
    if directory.id == "producthunt":
        return submit_producthunt(name, url, tagline, description)
    elif directory.id == "betalist":
        return submit_betalist(name, url, tagline, description)
    elif directory.id == "reddit":
        return submit_reddit(name, url, tagline, description, args)
    else:
        print(f"⚠️  No API implementation for {directory.id}, opening browser")
        return submit_browser(directory, name, url, tagline, description)


def submit_producthunt(name: str, url: str, tagline: str, description: str) -> bool:
    """Submit to Product Hunt via API."""
    token = os.environ.get("PRODUCTHUNT_TOKEN")
    if not token:
        print("❌ PRODUCTHUNT_TOKEN not set")
        return False
    
    try:
        import urllib.request
        
        # Product Hunt GraphQL API
        query = """
        mutation CreatePost($input: PostCreateInput!) {
            createPost(input: $input) {
                post { id slug }
                errors { field message }
            }
        }
        """
        
        variables = {
            "input": {
                "name": name,
                "tagline": tagline,
                "url": url,
                "description": description
            }
        }
        
        data = json.dumps({"query": query, "variables": variables}).encode()
        req = urllib.request.Request(
            "https://api.producthunt.com/v2/api/graphql",
            data=data,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json"
            }
        )
        
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
            if result.get("data", {}).get("createPost", {}).get("post"):
                return True
            else:
                errors = result.get("data", {}).get("createPost", {}).get("errors", [])
                for e in errors:
                    print(f"   {e.get('field')}: {e.get('message')}")
                return False
                
    except Exception as e:
        print(f"❌ API error: {e}")
        return False


def submit_betalist(name: str, url: str, tagline: str, description: str) -> bool:
    """Submit to BetaList via API."""
    token = os.environ.get("BETALIST_TOKEN")
    if not token:
        print("❌ BETALIST_TOKEN not set")
        return False
    
    try:
        import urllib.request
        
        data = json.dumps({
            "startup": {
                "name": name,
                "url": url,
                "one_liner": tagline,
                "description": description
            }
        }).encode()
        
        req = urllib.request.Request(
            "https://betalist.com/api/v1/startups",
            data=data,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json"
            }
        )
        
        with urllib.request.urlopen(req) as resp:
            return resp.status == 201
            
    except Exception as e:
        print(f"❌ API error: {e}")
        return False


def submit_reddit(name: str, url: str, tagline: str, description: str, args) -> bool:
    """Submit to Reddit via API."""
    # Reddit requires OAuth - complex setup
    # For now, fall back to browser
    print("⚠️  Reddit API requires OAuth setup, opening browser")
    subreddit = getattr(args, 'subreddit', 'SideProject')
    title = f"{name} – {tagline}"
    submit_url = f"https://www.reddit.com/r/{subreddit}/submit?title={quote_plus(title)}&url={quote_plus(url)}"
    webbrowser.open(submit_url)
    return True


def submit_browser(directory: Directory, name: str, url: str, tagline: str, description: str) -> bool:
    """Open browser with pre-filled URL."""
    submit_url = directory.submit_url
    
    # Some platforms support URL params
    if "news.ycombinator.com" in submit_url:
        title = f"Show HN: {name} – {tagline}"
        submit_url = f"{submit_url}?t={quote_plus(title)}&u={quote_plus(url)}"
    elif "reddit.com" in submit_url:
        title = f"{name} – {tagline}"
        submit_url = f"{submit_url}?title={quote_plus(title)}&url={quote_plus(url)}"
    
    print(f"🌐 Opening: {submit_url}")
    webbrowser.open(submit_url)
    return True


def submit_form(directory: Directory, name: str, url: str, tagline: str, description: str) -> bool:
    """Open form-based submission page."""
    print(f"📝 Opening submission form: {directory.submit_url}")
    print(f"   Name: {name}")
    print(f"   URL: {url}")
    print(f"   Tagline: {tagline}")
    webbrowser.open(directory.submit_url)
    return True


def cmd_submit_all(args):
    """Submit to multiple directories."""
    # Filter directories
    dirs = DIRECTORIES
    
    if args.tier:
        dirs = [d for d in dirs if d.tier <= args.tier]
    if args.platforms:
        platform_ids = [p.strip().lower() for p in args.platforms.split(",")]
        dirs = [d for d in dirs if d.id in platform_ids]
    if args.category:
        dirs = [d for d in dirs if d.category == args.category]
    
    print(f"🚀 Submitting to {len(dirs)} directories...")
    
    if args.dry_run:
        print("\n[DRY RUN — No actual submissions]\n")
        for d in dirs:
            print(f"  • {d.name} ({d.method})")
        return
    
    successes = 0
    failures = 0
    
    for directory in dirs:
        try:
            # Create fake args for submit
            submit_args = argparse.Namespace(
                platform=directory.id,
                name=args.name,
                url=args.url,
                tagline=args.tagline,
                description=args.description,
                data=args.data,
                subreddit=getattr(args, 'subreddit', 'SideProject')
            )
            cmd_submit(submit_args)
            successes += 1
        except Exception as e:
            print(f"❌ {directory.name}: {e}")
            failures += 1
        
        # Small delay between submissions
        if not args.no_delay:
            import time
            time.sleep(1)
    
    print(f"\n✅ {successes} submitted, ❌ {failures} failed")


def cmd_status(args):
    """Show submission status."""
    data = load_submissions()
    submissions = data.get("submissions", [])
    
    if args.name:
        submissions = [s for s in submissions if s.get("startup", "").lower() == args.name.lower()]
    if args.pending:
        submissions = [s for s in submissions if s.get("status") == "pending"]
    
    if not submissions:
        print("No submissions found.")
        return
    
    # Group by startup
    by_startup = {}
    for s in submissions:
        by_startup.setdefault(s.get("startup", "Unknown"), []).append(s)
    
    for startup, subs in by_startup.items():
        print(f"\n## {startup}")
        print(f"{'Platform':<20} {'Status':<12} {'Date'}")
        print("-" * 50)
        for s in sorted(subs, key=lambda x: x.get("timestamp", ""), reverse=True):
            platform = s.get("platform", "?")
            status = s.get("status", "?")
            ts = s.get("timestamp", "?")[:10]
            emoji = "✅" if status == "submitted" else "❌" if status == "failed" else "⏳"
            print(f"{platform:<20} {emoji} {status:<10} {ts}")


def main():
    parser = argparse.ArgumentParser(description="Launch Directories — Submit to 40+ platforms")
    subparsers = parser.add_subparsers(dest="command", required=True)
    
    # list
    list_parser = subparsers.add_parser("list", help="List available directories")
    list_parser.add_argument("--tier", type=int, choices=[1, 2, 3, 4], help="Filter by tier")
    list_parser.add_argument("--method", choices=["api", "form", "browser"], help="Filter by method")
    list_parser.add_argument("--category", choices=["general", "ai", "dev", "indie"], help="Filter by category")
    list_parser.add_argument("--all", action="store_true", help="Show all details")
    
    # submit
    submit_parser = subparsers.add_parser("submit", help="Submit to one directory")
    submit_parser.add_argument("platform", help="Platform ID (e.g., producthunt)")
    submit_parser.add_argument("--name", help="Product name")
    submit_parser.add_argument("--url", help="Product URL")
    submit_parser.add_argument("--tagline", help="Short tagline")
    submit_parser.add_argument("--description", help="Longer description")
    submit_parser.add_argument("--data", help="JSON file with submission data")
    submit_parser.add_argument("--subreddit", default="SideProject", help="Reddit subreddit")
    
    # submit-all
    all_parser = subparsers.add_parser("submit-all", help="Submit to multiple directories")
    all_parser.add_argument("--tier", type=int, choices=[1, 2, 3, 4], help="Submit to this tier and below")
    all_parser.add_argument("--platforms", help="Comma-separated platform IDs")
    all_parser.add_argument("--category", choices=["general", "ai", "dev", "indie"], help="Filter by category")
    all_parser.add_argument("--name", help="Product name")
    all_parser.add_argument("--url", help="Product URL")
    all_parser.add_argument("--tagline", help="Short tagline")
    all_parser.add_argument("--description", help="Longer description")
    all_parser.add_argument("--data", help="JSON file with submission data")
    all_parser.add_argument("--dry-run", action="store_true", help="Show what would be submitted")
    all_parser.add_argument("--no-delay", action="store_true", help="Don't delay between submissions")
    
    # status
    status_parser = subparsers.add_parser("status", help="Check submission status")
    status_parser.add_argument("--name", help="Filter by startup name")
    status_parser.add_argument("--pending", action="store_true", help="Show pending only")
    
    args = parser.parse_args()
    
    if args.command == "list":
        cmd_list(args)
    elif args.command == "submit":
        cmd_submit(args)
    elif args.command == "submit-all":
        cmd_submit_all(args)
    elif args.command == "status":
        cmd_status(args)


if __name__ == "__main__":
    main()
