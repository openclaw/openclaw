"""DB-first combo metrics store — fail-safe stub.

V1 behavior (safe):
- Tries to read from a materialized view (or normal view) fed by attribution ledger.
- If view/table missing OR row missing -> returns None.
- StabilityGate will fail-safe and skip queued remainder.

Later:
- Replace/extend with real-time Meta Insights pull + ledger joins.
"""
from __future__ import annotations

import sqlite3
from typing import Any, Optional

from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.stores.combo_metrics")


class ComboMetricsStore:
    """Read combo performance metrics from materialized views.

    Parameters
    ----------
    conn : sqlite3.Connection
        Database connection with ``row_factory = sqlite3.Row``.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def get_combo_metrics(
        self,
        *,
        combo_id: str,
        brand: str,
        window: str,
    ) -> Optional[dict[str, Any]]:
        """Fetch metrics for a combo from the appropriate materialized view.

        Parameters
        ----------
        combo_id : str
            The combo identifier, e.g. ``"combo_14"``.
        brand : str
            Brand slug — ``"cutmv"`` or ``"fulldigital"``.
        window : str
            Time window — ``"last_24h"``, ``"prev_2d"``, ``"prev_3d"``, etc.

        Returns
        -------
        dict | None
            Dict with keys: ``spend_usd``, ``conversions``, ``cpa``, ``roas``,
            ``fatigue_score``, ``calls_showed``, ``pipeline_quality``,
            ``close_rate``.
            Returns ``None`` if the view does not exist or the row is missing,
            causing StabilityGate to fail safe.
        """
        view_name = self._window_to_view(window)
        if not view_name:
            log.debug("combo_metrics_unknown_window", extra={"window": window})
            return None

        if not self._view_exists(view_name):
            log.debug("combo_metrics_view_missing", extra={"view": view_name})
            return None

        try:
            row = self.conn.execute(
                f"SELECT brand, combo_id, spend_usd, conversions, cpa, roas, "
                f"fatigue_score, calls_showed, pipeline_quality, close_rate "
                f"FROM {view_name} WHERE brand = ? AND combo_id = ?",
                (brand, combo_id),
            ).fetchone()
        except Exception:
            log.warning("combo_metrics_query_failed", extra={"view": view_name})
            return None

        if not row:
            return None

        return dict(row)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _window_to_view(window: str) -> Optional[str]:
        """Map window string to view name. Returns None for unknown windows."""
        mapping = {
            "last_24h": "mv_combo_metrics_last_24h",
            "prev_2d": "mv_combo_metrics_prev_2d",
            "prev_3d": "mv_combo_metrics_prev_3d",
        }
        return mapping.get(window)

    def _view_exists(self, name: str) -> bool:
        """Check whether a view or table exists in sqlite_master."""
        try:
            row = self.conn.execute(
                "SELECT name FROM sqlite_master "
                "WHERE (type='view' OR type='table') AND name=?",
                (name,),
            ).fetchone()
            return bool(row)
        except Exception:
            return False
