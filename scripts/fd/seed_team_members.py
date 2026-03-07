"""Seed team_members table with initial designer roster."""
from __future__ import annotations

import json
import time

from packages.common.config import settings
from packages.common.db import connect, init_schema

SEED = [
    {
        "member_id": "maya",
        "display_name": "Maya",
        "role": "designer_motion",
        "capacity_points": 10,
        "skills": ["motion", "ads"],
    },
    {
        "member_id": "jay",
        "display_name": "Jay",
        "role": "designer_static",
        "capacity_points": 10,
        "skills": ["cover_art", "flyers"],
    },
]


def main() -> None:
    conn = connect(settings.SQLITE_PATH)
    init_schema(conn)
    for m in SEED:
        conn.execute(
            """
            INSERT OR REPLACE INTO team_members
            (member_id, display_name, role, is_active, capacity_points, skills_json, ts)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                m["member_id"],
                m["display_name"],
                m["role"],
                1,
                m["capacity_points"],
                json.dumps(m["skills"]),
                int(time.time()),
            ),
        )
    conn.commit()
    print("Seeded team members.")


if __name__ == "__main__":
    main()
