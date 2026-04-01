# Claude-Style Agent Layout

This workspace now follows Claude-style agent roles instead of custom court titles.

## Core Roles

- `coordinator`: orchestrates multi-agent work and synthesizes the final answer
- `general-purpose`: default worker for broad multi-step execution
- `Explore`: fast read-only codebase search specialist
- `Plan`: read-only planning and architecture specialist
- `Verification`: adversarial verifier that tries to break the result

## Organization Pattern

- coordinator spawns workers or teammates when the task benefits from specialization
- read-only analysis should prefer `Explore` or `Plan`
- final claims should pass through `Verification` before being treated as done

## Why This Changed

The previous naming (`taizi`, `zhongshu`, `hubu`, `menxia`, `yushi`, `shangshu`) was custom and not aligned with Claude's actual structure.

Claude's leaked code points much closer to:

- built-in agents: `general-purpose`, `Explore`, `Plan`, `Verification`
- swarm organization: `coordinator`, `leader`, `teammate`, `worker`
