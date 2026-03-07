"""Experiment Matrix — Variant combo generation from config/variants.yaml.

Reads the variant configuration and generates Cartesian product test matrices.
Each combo represents a unique (creative × CTA × DM copy × offer × audience) combination
with a stable hash ID for attribution tracking.

Supports:
- Full Cartesian product or constrained subsets
- Stable combo_id hashing for cross-system identity
- Budget cap enforcement (max combos per launch)
- Full Digital offer catalog expansion from offers_full_digital.yaml
- Offer rotation guardrails from experiment_policy.yaml
"""
from __future__ import annotations

import hashlib
import itertools
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.experiment_matrix")

# Default catalog paths relative to this file
_OFFERS_CATALOG_PATH = Path(__file__).resolve().parent.parent / "config" / "offers_full_digital.yaml"
_POLICY_PATH = Path(__file__).resolve().parent.parent / "config" / "experiment_policy.yaml"


@dataclass(frozen=True)
class VariantCombo:
    """A single testable variant combination."""

    combo_id: str
    brand: str
    creative_id: str
    cta_id: str
    dm_copy_id: str
    offer_id: str
    audience_id: str
    trigger_keyword: str


def _stable_id(parts: list[str]) -> str:
    """Generate a stable 16-char hex ID from variant parts."""
    raw = "|".join(parts).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def load_offer_catalog(
    catalog_path: str | Path | None = None,
) -> list[dict[str, Any]]:
    """Load Full Digital offer catalog and convert to variant-compatible dicts.

    Each offer becomes an entry with 'id' and 'name' fields matching the
    variant format used by the experiment matrix.
    """
    path = Path(catalog_path) if catalog_path else _OFFERS_CATALOG_PATH
    if not path.exists():
        log.warning("offer_catalog_not_found", extra={"path": str(path)})
        return []

    with open(path, encoding="utf-8") as f:
        catalog = yaml.safe_load(f)

    offers = catalog.get("offers", [])
    return [
        {"id": o["id"], "name": o.get("name", o["id"]), "category": o.get("category", "")}
        for o in offers
    ]


def load_offer_rotation_policy(
    policy_path: str | Path | None = None,
) -> dict[str, Any]:
    """Load offer rotation rules from experiment_policy.yaml."""
    path = Path(policy_path) if policy_path else _POLICY_PATH
    if not path.exists():
        return {}

    with open(path, encoding="utf-8") as f:
        policy = yaml.safe_load(f)

    return policy.get("offer_rotation", {})


class ExperimentMatrix:
    """Generates variant combos from a YAML config file or dict.

    For fulldigital, offers are sourced from the offer catalog
    (offers_full_digital.yaml) and filtered by the offer rotation
    policy's starter_rack and active offer caps.
    """

    def __init__(
        self,
        config: dict[str, Any] | None = None,
        config_path: str | None = None,
        offer_catalog_path: str | Path | None = None,
        policy_path: str | Path | None = None,
    ) -> None:
        if config is not None:
            self.cfg = config
        elif config_path is not None:
            with open(config_path, encoding="utf-8") as f:
                self.cfg = yaml.safe_load(f)
        else:
            self.cfg = {}

        self._offer_catalog_path = offer_catalog_path
        self._policy_path = policy_path
        self._offer_catalog: list[dict[str, Any]] | None = None
        self._rotation_policy: dict[str, Any] | None = None

    @property
    def offer_catalog(self) -> list[dict[str, Any]]:
        if self._offer_catalog is None:
            self._offer_catalog = load_offer_catalog(self._offer_catalog_path)
        return self._offer_catalog

    @property
    def rotation_policy(self) -> dict[str, Any]:
        if self._rotation_policy is None:
            self._rotation_policy = load_offer_rotation_policy(self._policy_path)
        return self._rotation_policy

    def _resolve_offers(
        self,
        brand: str,
        base_offers: list[dict[str, Any]],
        constraints: dict[str, list[str]] | None,
    ) -> list[dict[str, Any]]:
        """Resolve offers for a brand, expanding from catalog for fulldigital.

        For fulldigital:
        1. Source offers from the offer catalog (if available)
        2. Filter to starter_rack IDs from rotation policy
        3. Cap at never_exceed_active_offers_per_brand

        For other brands or when no catalog exists, use base_offers from variants.yaml.
        """
        if brand == "fulldigital" and self.offer_catalog:
            offers = list(self.offer_catalog)

            # Apply starter rack filter from rotation policy
            rotation = self.rotation_policy
            if rotation.get("enabled") and rotation.get("starter_rack"):
                rack_ids = set(rotation["starter_rack"])
                offers = [o for o in offers if o["id"] in rack_ids]

            # Cap at max active offers
            guardrails = rotation.get("guardrails", {})
            max_offers = guardrails.get("never_exceed_active_offers_per_brand")
            if max_offers and len(offers) > max_offers:
                offers = offers[:max_offers]
        else:
            offers = base_offers

        # Apply explicit constraint filter
        if constraints and "offer_ids" in constraints:
            allow = set(constraints["offer_ids"])
            offers = [o for o in offers if o["id"] in allow]

        return offers

    def generate(
        self,
        brand: str,
        limit: int | None = None,
        constraints: dict[str, list[str]] | None = None,
    ) -> list[VariantCombo]:
        """Generate Cartesian product test combos with optional constraints.

        Args:
            brand: 'cutmv' or 'fulldigital'
            limit: Max combos to return
            constraints: Filter by ID lists, e.g. {"cta_ids": ["cta_01"]}

        Returns:
            List of VariantCombo instances with stable combo_id hashes.
        """
        b = self.cfg.get("brands", {}).get(brand, {})
        if not b:
            log.warning("brand_not_found_in_config", extra={"brand": brand})
            return []

        creatives = b.get("ad_creatives", [])
        ctas = b.get("ctas", [])
        dm_copies = b.get("dm_copy_variants", [])
        base_offers = b.get("offers", [])
        audiences = b.get("audience_segments", [])

        def apply_constraint(items: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
            if not constraints or key not in constraints:
                return items
            allow = set(constraints[key])
            return [x for x in items if x["id"] in allow]

        creatives = apply_constraint(creatives, "creative_ids")
        ctas = apply_constraint(ctas, "cta_ids")
        dm_copies = apply_constraint(dm_copies, "dm_copy_ids")
        audiences = apply_constraint(audiences, "audience_ids")

        # Offers resolved via catalog + rotation policy for fulldigital
        offers = self._resolve_offers(brand, base_offers, constraints)

        default_keyword = b.get("default_trigger_keyword", "INFO")

        combos: list[VariantCombo] = []
        for cr, cta, dm, off, aud in itertools.product(creatives, ctas, dm_copies, offers, audiences):
            trigger_keyword = cta.get("trigger_keyword") or default_keyword
            combo_id = _stable_id([
                brand, cr["id"], cta["id"], dm["id"], off["id"], aud["id"], trigger_keyword,
            ])
            combos.append(VariantCombo(
                combo_id=combo_id,
                brand=brand,
                creative_id=cr["id"],
                cta_id=cta["id"],
                dm_copy_id=dm["id"],
                offer_id=off["id"],
                audience_id=aud["id"],
                trigger_keyword=trigger_keyword,
            ))

        if limit:
            combos = combos[:limit]

        log.info("matrix_generated", extra={"brand": brand, "combos": len(combos), "limit": limit})
        return combos

    def count_possible_combos(self, brand: str) -> int:
        """Count total possible combos without generating them."""
        b = self.cfg.get("brands", {}).get(brand, {})
        if not b:
            return 0

        base_offers = b.get("offers", [])
        offers = self._resolve_offers(brand, base_offers, None)

        return (
            len(b.get("ad_creatives", []))
            * len(b.get("ctas", []))
            * len(b.get("dm_copy_variants", []))
            * len(offers)
            * len(b.get("audience_segments", []))
        )
