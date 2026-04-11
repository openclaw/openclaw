from __future__ import annotations

import json
import os
import shutil
from importlib import resources
from pathlib import Path
from typing import Any


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def toolbox_path() -> Path:
    configured = os.environ.get("CLAWMODELER_TOOLBOX")
    if configured:
        return Path(configured)
    candidates = [
        repo_root() / "clawmodeler_toolbox.json",
        Path.cwd() / "clawmodeler_toolbox.json",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return repo_root() / "clawmodeler_toolbox.json"


def load_toolbox() -> dict[str, Any]:
    path = toolbox_path()
    if path.exists():
        with path.open("r", encoding="utf-8") as file:
            data = json.load(file)
    else:
        data = json.loads(
            resources.files("clawmodeler_engine")
            .joinpath("toolbox.default.json")
            .read_text(encoding="utf-8")
        )
    if not isinstance(data, dict):
        raise ValueError("clawmodeler_toolbox.json must contain an object.")
    return data


def model_root() -> Path:
    configured = os.environ.get("CLAWMODELER_MODEL_ROOT")
    if configured:
        return Path(configured)
    if any((Path.cwd() / name).exists() for name in ("sumo", "matsim-libs", "urbansim")):
        return Path.cwd()
    return repo_root()


def assess_toolbox() -> dict[str, Any]:
    toolbox = load_toolbox()
    tools = [assess_tool(tool) for tool in toolbox.get("tools", [])]
    profiles = assess_profiles(toolbox, tools)
    return {
        "schema_version": toolbox.get("schema_version"),
        "profiles": profiles,
        "tools": tools,
        "model_inventory": assess_model_inventory(),
        "method_policy": toolbox.get("method_policy", []),
    }


def assess_tool(tool: dict[str, Any]) -> dict[str, Any]:
    kind = str(tool.get("kind", "unknown"))
    available = False
    detail = "unknown tool kind"

    if kind == "binary":
        binary = str(tool.get("binary", tool.get("id", "")))
        resolved = shutil.which(binary)
        available = resolved is not None
        detail = resolved if resolved else f"{binary} not found on PATH"
    elif kind == "python_module":
        module_name = str(tool.get("module", tool.get("id", "")))
        try:
            __import__(module_name)
        except ModuleNotFoundError:
            detail = f"{module_name} is not installed"
        else:
            available = True
            detail = f"{module_name} import succeeded"
    elif kind == "path":
        path = model_root() / str(tool.get("path", ""))
        available = path.exists()
        detail = str(path) if available else f"{path} not present"
    elif kind == "file_glob":
        matches = sorted(model_root().glob(str(tool.get("glob", ""))))
        available = len(matches) > 0
        detail = str(matches[0]) if matches else f"No files matched {tool.get('glob')}"

    required = bool(tool.get("required"))
    status = "ok" if available else ("missing" if required else "optional")
    return {
        **tool,
        "available": available,
        "status": status,
        "detail": detail,
    }


def assess_profiles(toolbox: dict[str, Any], tools: list[dict[str, Any]]) -> dict[str, Any]:
    profiles: dict[str, Any] = {}
    tools_by_profile: dict[str, list[dict[str, Any]]] = {}
    for tool in tools:
        tools_by_profile.setdefault(str(tool.get("profile", "unassigned")), []).append(tool)

    for profile_id, profile in toolbox.get("profiles", {}).items():
        profile_tools = tools_by_profile.get(profile_id, [])
        required_missing = [
            tool["id"] for tool in profile_tools if tool.get("required") and not tool["available"]
        ]
        optional_available = sum(
            1 for tool in profile_tools if not tool.get("required") and tool["available"]
        )
        optional_total = sum(1 for tool in profile_tools if not tool.get("required"))
        profiles[profile_id] = {
            **profile,
            "required_missing": required_missing,
            "optional_available": optional_available,
            "optional_total": optional_total,
            "ready": len(required_missing) == 0,
        }
    return profiles


def toolbox_summary_lines(assessment: dict[str, Any]) -> list[str]:
    lines = ["ClawModeler toolbox"]
    lines.append("")
    lines.append("Profiles:")
    for profile_id, profile in assessment["profiles"].items():
        ready = "ready" if profile["ready"] else "missing required tools"
        lines.append(
            f"- {profile_id}: {ready}; optional {profile['optional_available']}/"
            f"{profile['optional_total']} available"
        )
    lines.append("")
    lines.append("Tools:")
    for tool in assessment["tools"]:
        lines.append(
            f"- {tool['status']}: {tool['id']} ({tool['category']}) - {tool['purpose']}"
        )
    lines.append("")
    lines.append("Model inventory:")
    for model in assessment.get("model_inventory", []):
        readiness = "ready" if model["ready"] else "present but needs setup"
        lines.append(
            f"- {model['id']}: {readiness}; signals {len(model['signals'])}/"
            f"{len(model['expected_signals'])} at {model['path']}"
        )
    lines.append("")
    lines.append("Method policy:")
    for policy in assessment["method_policy"]:
        lines.append(
            f"- when {policy['when']}: prefer {', '.join(policy['prefer'])}; "
            f"fallback: {policy['fallback']}"
        )
    return lines


def assess_model_inventory() -> list[dict[str, Any]]:
    definitions = [
        {
            "id": "sumo",
            "name": "SUMO",
            "path": "sumo",
            "role": "Microscopic traffic simulation and network operations.",
            "expected_signals": ["README.md", "tools/randomTrips.py", "tests/runTests.sh"],
            "agent_next_step": "Use bridge manifests first; run SUMO binaries when installed.",
        },
        {
            "id": "matsim",
            "name": "MATSim",
            "path": "matsim-libs",
            "role": "Agent-based demand simulation.",
            "expected_signals": ["pom.xml", "matsim/pom.xml", "examples/pom.xml"],
            "agent_next_step": "Prepare network, population, and plans handoffs.",
        },
        {
            "id": "urbansim",
            "name": "UrbanSim",
            "path": "urbansim",
            "role": "Land-use and transportation interaction modeling.",
            "expected_signals": ["setup.py", "urbansim/__init__.py", "README.rst"],
            "agent_next_step": "Prepare parcel/building/household/job scenario tables.",
        },
        {
            "id": "dtalite",
            "name": "DTALite",
            "path": "DTALite",
            "role": "Dynamic traffic assignment.",
            "expected_signals": ["CMakeLists.txt", "src/assignment.h", "README.md"],
            "agent_next_step": "Prepare network and OD matrix handoff files.",
        },
        {
            "id": "tbest",
            "name": "TBEST tools",
            "path": "tbest-tools",
            "role": "Transit ridership and stop-level tooling.",
            "expected_signals": [
                "TBESTTools.sln",
                "RidershipEstimationModel/RidershipEstimationModel.csproj",
                "README.md",
            ],
            "agent_next_step": "Prepare stop, route, ridership, and service input handoffs.",
        },
    ]
    return [assess_model_definition(definition) for definition in definitions]


def assess_model_definition(definition: dict[str, Any]) -> dict[str, Any]:
    root = model_root()
    path = root / str(definition["path"])
    expected = list(definition["expected_signals"])
    signals = [signal for signal in expected if (path / signal).exists()]
    git_remote = read_git_remote(path)
    present = path.exists()
    return {
        **definition,
        "path": str(path),
        "present": present,
        "signals": signals,
        "ready": present and len(signals) >= max(1, len(expected) - 1),
        "git_remote": git_remote,
    }


def read_git_remote(path: Path) -> str | None:
    config_path = path / ".git" / "config"
    if not config_path.exists():
        return None
    current_section = ""
    for raw_line in config_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if line.startswith("[") and line.endswith("]"):
            current_section = line
            continue
        if current_section == '[remote "origin"]' and line.startswith("url ="):
            return line.split("=", 1)[1].strip()
    return None
