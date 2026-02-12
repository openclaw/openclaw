"""
O.R.I.O.N. SKILL MODULE: THE DISCOVERY AGENT
=============================================
This file is part of THE LAB - Updatable skills and plugins.
Status: UPDATABLE - Can be improved through the Evolution Engine.

The Scout module monitors GitHub repositories for new releases
and notifies the Evolution Engine about available updates.

Constraint: READ-ONLY access to the internet. No data upload.
"""

import requests
import json
import os
from typing import Dict, Optional, List, Any
from datetime import datetime
from packaging import version  # For version comparison


class Scout:
    """
    The Discovery Agent - Monitors GitHub for new tool releases.
    Read-only internet access for safety.
    """

    def __init__(self, state_file: str = "./state.json"):
        """
        Initialize the Scout with a state file to track known versions.

        Args:
            state_file: Path to JSON file storing current versions
        """
        self.state_file = state_file
        self.state = self._load_state()
        self.github_api_base = "https://api.github.com"

        print("🔭 Scout initialized")
        print(f"   State file: {state_file}")
        print(f"   Tracking {len(self.state.get('repos', {}))} repositories")

    def _load_state(self) -> Dict[str, Any]:
        """
        Load the state file containing current versions.

        Returns:
            Dict with repo versions, or empty structure if file doesn't exist
        """
        if os.path.exists(self.state_file):
            try:
                with open(self.state_file, 'r') as f:
                    return json.load(f)
            except Exception as e:
                print(f"⚠️ Error loading state file: {e}")
                return {"repos": {}, "last_updated": None}
        else:
            # Initialize empty state
            return {"repos": {}, "last_updated": None}

    def _save_state(self) -> None:
        """Save the current state to disk."""
        self.state["last_updated"] = datetime.now().isoformat()
        try:
            with open(self.state_file, 'w') as f:
                json.dump(self.state, indent=2, fp=f)
            print(f"💾 State saved to {self.state_file}")
        except Exception as e:
            print(f"❌ Error saving state: {e}")

    def _get_latest_release(self, repo_owner: str, repo_name: str) -> Optional[Dict[str, Any]]:
        """
        Fetch the latest release from a GitHub repository.

        Args:
            repo_owner: GitHub username/organization
            repo_name: Repository name

        Returns:
            Dict with release info, or None if error
        """
        url = f"{self.github_api_base}/repos/{repo_owner}/{repo_name}/releases/latest"

        try:
            # Note: GitHub API has rate limits (60 req/hour unauthenticated)
            # For production, consider adding authentication token
            response = requests.get(url, timeout=10)

            if response.status_code == 200:
                release_data = response.json()
                return {
                    "tag_name": release_data.get("tag_name", ""),
                    "name": release_data.get("name", ""),
                    "published_at": release_data.get("published_at", ""),
                    "html_url": release_data.get("html_url", ""),
                    "tarball_url": release_data.get("tarball_url", ""),
                    "zipball_url": release_data.get("zipball_url", ""),
                    "body": release_data.get("body", "")[:200]  # Truncate description
                }
            elif response.status_code == 404:
                print(f"⚠️ Repository not found or has no releases: {repo_owner}/{repo_name}")
                return None
            else:
                print(f"⚠️ GitHub API error: {response.status_code}")
                return None

        except requests.exceptions.Timeout:
            print("⚠️ Request timed out - check internet connection")
            return None
        except requests.exceptions.ConnectionError:
            print("⚠️ Connection error - internet may be down")
            return None
        except Exception as e:
            print(f"❌ Error fetching release: {e}")
            return None

    def check_for_update(self, repo_owner: str, repo_name: str) -> Optional[Dict[str, Any]]:
        """
        Check if a new version is available for a repository.

        Args:
            repo_owner: GitHub username/organization
            repo_name: Repository name

        Returns:
            Dict with update info if new version found, None otherwise
            Dict contains: {
                'repo': str,
                'current_version': str,
                'new_version': str,
                'download_url': str,
                'release_notes': str
            }
        """
        repo_key = f"{repo_owner}/{repo_name}"
        print(f"\n🔍 Checking for updates: {repo_key}")

        # Get latest release from GitHub
        latest_release = self._get_latest_release(repo_owner, repo_name)

        if latest_release is None:
            return None

        new_version = latest_release["tag_name"].lstrip('v')  # Remove 'v' prefix
        current_version = self.state["repos"].get(repo_key, {}).get("version", "0.0.0")

        print(f"   Current: {current_version}")
        print(f"   Latest:  {new_version}")

        # Compare versions
        try:
            if version.parse(new_version) > version.parse(current_version):
                print(f"   ✨ New version available!")

                # Prefer zipball for easier extraction
                download_url = latest_release["zipball_url"]

                return {
                    "repo": repo_key,
                    "current_version": current_version,
                    "new_version": new_version,
                    "download_url": download_url,
                    "release_notes": latest_release["body"],
                    "html_url": latest_release["html_url"]
                }
            else:
                print(f"   ✅ Already up to date")
                return None

        except Exception as e:
            print(f"   ⚠️ Error comparing versions: {e}")
            return None

    def mark_as_updated(self, repo_owner: str, repo_name: str, new_version: str) -> None:
        """
        Update the state file to reflect that a repo has been updated.

        Args:
            repo_owner: GitHub username/organization
            repo_name: Repository name
            new_version: The version that was installed
        """
        repo_key = f"{repo_owner}/{repo_name}"

        if "repos" not in self.state:
            self.state["repos"] = {}

        self.state["repos"][repo_key] = {
            "version": new_version,
            "updated_at": datetime.now().isoformat()
        }

        self._save_state()
        print(f"✅ Marked {repo_key} as updated to {new_version}")

    def scan_watchlist(self, watchlist: List[Dict[str, str]]) -> List[Dict[str, Any]]:
        """
        Scan a list of repositories for updates.

        Args:
            watchlist: List of dicts with 'owner' and 'name' keys

        Returns:
            List of available updates
        """
        print("\n" + "=" * 60)
        print("🔭 SCOUT - SCANNING FOR UPDATES")
        print("=" * 60)

        updates_available = []

        for repo_info in watchlist:
            owner = repo_info.get("owner")
            name = repo_info.get("name")

            if not owner or not name:
                print(f"⚠️ Skipping invalid repo entry: {repo_info}")
                continue

            update_info = self.check_for_update(owner, name)

            if update_info:
                updates_available.append(update_info)

        print("\n" + "=" * 60)
        print(f"📊 Scan complete: {len(updates_available)} update(s) available")
        print("=" * 60 + "\n")

        return updates_available


if __name__ == "__main__":
    # Test the Scout
    print("O.R.I.O.N. SCOUT TEST")
    print("=" * 60 + "\n")

    scout = Scout()

    # Example watchlist
    watchlist = [
        {"owner": "snakers4", "name": "silero-vad"},  # Voice Activity Detection
        {"owner": "openai", "name": "whisper"},       # Speech recognition
        # Add more repos as needed
    ]

    # Scan for updates
    updates = scout.scan_watchlist(watchlist)

    # Display results
    if updates:
        print("\n🎯 Updates found:")
        for update in updates:
            print(f"\n  Repository: {update['repo']}")
            print(f"  Current: {update['current_version']} → New: {update['new_version']}")
            print(f"  Download: {update['download_url']}")
    else:
        print("\n✅ All repositories are up to date")
