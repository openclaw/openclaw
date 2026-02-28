#!/usr/bin/env python3
"""
OpenClaw telemetry visualizations.

Generates charts from cron run logs and session data using matplotlib.
Optionally uses plotly for interactive HTML charts.

Usage:
    from visualize import CronViz

    viz = CronViz(df)          # pass a DataFrame from load_cron_runs()
    viz.daily_success_rate()   # show chart
    viz.save_all("./charts")   # export all charts to a directory
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import matplotlib
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np
import pandas as pd

# Use non-interactive backend when saving to file
if not os.environ.get("DISPLAY") and not sys.stdout.isatty():
    matplotlib.use("Agg")

# Style
plt.style.use("seaborn-v0_8-whitegrid")
COLORS = {
    "ok": "#2ecc71",
    "error": "#e74c3c",
    "skipped": "#f39c12",
    "primary": "#3498db",
    "secondary": "#9b59b6",
    "accent": "#1abc9c",
    "bg": "#fafafa",
}


class CronViz:
    """Visualization suite for cron run log DataFrames."""

    def __init__(self, df: pd.DataFrame):
        self.df = df.copy()
        if "date" not in self.df.columns and "timestamp" in self.df.columns:
            self.df["date"] = self.df["timestamp"].dt.date

    # ------------------------------------------------------------------
    # 1. Daily success rate timeline
    # ------------------------------------------------------------------

    def daily_success_rate(
        self, figsize: tuple = (12, 5), save_path: Optional[str] = None
    ) -> plt.Figure:
        """Bar chart of daily run counts colored by status, with success rate overlay."""
        daily = self.df.groupby("date")["status"].value_counts().unstack(fill_value=0)

        fig, ax1 = plt.subplots(figsize=figsize, facecolor=COLORS["bg"])
        ax1.set_facecolor(COLORS["bg"])

        statuses = ["ok", "error", "skipped"]
        bottom = np.zeros(len(daily))

        for status in statuses:
            if status in daily.columns:
                vals = daily[status].values.astype(float)
                ax1.bar(
                    range(len(daily)),
                    vals,
                    bottom=bottom,
                    label=status.capitalize(),
                    color=COLORS.get(status, "#bdc3c7"),
                    alpha=0.85,
                    width=0.7,
                )
                bottom += vals

        # Success rate line
        ax2 = ax1.twinx()
        totals = daily.sum(axis=1)
        ok_counts = daily.get("ok", pd.Series(0, index=daily.index))
        rate = (ok_counts / totals * 100).fillna(0)
        ax2.plot(
            range(len(daily)),
            rate,
            color=COLORS["primary"],
            linewidth=2.5,
            marker="o",
            markersize=5,
            label="Success Rate",
        )
        ax2.set_ylim(0, 105)
        ax2.set_ylabel("Success Rate (%)", fontsize=11)
        ax2.legend(loc="upper left")

        ax1.set_xticks(range(len(daily)))
        ax1.set_xticklabels(
            [str(d) for d in daily.index], rotation=45, ha="right", fontsize=8
        )
        ax1.set_ylabel("Run Count", fontsize=11)
        ax1.set_title("Cron Job Runs — Daily Status & Success Rate", fontsize=14, fontweight="bold")
        ax1.legend(loc="upper right")

        fig.tight_layout()
        if save_path:
            fig.savefig(save_path, dpi=150, bbox_inches="tight")
        return fig

    # ------------------------------------------------------------------
    # 2. Model performance comparison
    # ------------------------------------------------------------------

    def model_comparison(
        self, figsize: tuple = (12, 5), save_path: Optional[str] = None
    ) -> plt.Figure:
        """Horizontal bar chart comparing models by avg duration and error rate."""
        if self.df.empty:
            return self._empty_fig("No data for model comparison")

        model_df = self.df.copy()
        model_df["model"] = model_df["model"].fillna("unknown")

        agg = model_df.groupby("model").agg(
            avg_duration=("duration_ms", "mean"),
            count=("status", "count"),
            errors=("status", lambda x: (x == "error").sum()),
        ).reset_index()
        agg["error_rate"] = agg["errors"] / agg["count"]
        agg = agg.sort_values("avg_duration", ascending=True)

        fig, (ax1, ax2) = plt.subplots(1, 2, figsize=figsize, facecolor=COLORS["bg"])

        # Left: avg duration
        bar_colors = [COLORS["primary"]] * len(agg)
        ax1.barh(agg["model"], agg["avg_duration"] / 1000, color=bar_colors, alpha=0.85)
        ax1.set_xlabel("Avg Duration (seconds)", fontsize=11)
        ax1.set_title("Avg Execution Time", fontsize=12, fontweight="bold")
        for spine in ax1.spines.values():
            spine.set_visible(False)

        # Right: error rate
        colors = [COLORS["error"] if r > 0.1 else COLORS["ok"] for r in agg["error_rate"]]
        ax2.barh(agg["model"], agg["error_rate"] * 100, color=colors, alpha=0.85)
        ax2.set_xlabel("Error Rate (%)", fontsize=11)
        ax2.set_title("Error Rate", fontsize=12, fontweight="bold")
        ax2.set_xlim(0, max(agg["error_rate"].max() * 100 * 1.2, 5))
        for spine in ax2.spines.values():
            spine.set_visible(False)

        # Annotate counts
        for i, (_, row) in enumerate(agg.iterrows()):
            ax1.text(
                agg["avg_duration"].iloc[i] / 1000 + 0.1,
                i,
                f'n={row["count"]}',
                va="center",
                fontsize=9,
                color="#666",
            )

        fig.suptitle(
            "Model Performance Comparison",
            fontsize=14,
            fontweight="bold",
            y=1.02,
        )
        fig.tight_layout()
        if save_path:
            fig.savefig(save_path, dpi=150, bbox_inches="tight")
        return fig

    # ------------------------------------------------------------------
    # 3. Token usage over time
    # ------------------------------------------------------------------

    def token_usage_timeline(
        self, figsize: tuple = (12, 5), save_path: Optional[str] = None
    ) -> plt.Figure:
        """Stacked area chart of daily token consumption by type."""
        if self.df.empty:
            return self._empty_fig("No data for token timeline")

        daily = self.df.groupby("date").agg(
            input=("input_tokens", "sum"),
            output=("output_tokens", "sum"),
            cache_read=("cache_read_tokens", "sum"),
            cache_write=("cache_write_tokens", "sum"),
        ).fillna(0)

        fig, ax = plt.subplots(figsize=figsize, facecolor=COLORS["bg"])
        ax.set_facecolor(COLORS["bg"])

        x = range(len(daily))
        labels = ["Input", "Output", "Cache Read", "Cache Write"]
        colors_stack = [COLORS["primary"], COLORS["secondary"], COLORS["accent"], COLORS["ok"]]

        ax.stackplot(
            x,
            daily["input"],
            daily["output"],
            daily["cache_read"],
            daily["cache_write"],
            labels=labels,
            colors=colors_stack,
            alpha=0.8,
        )

        ax.set_xticks(x)
        ax.set_xticklabels(
            [str(d) for d in daily.index], rotation=45, ha="right", fontsize=8
        )
        ax.set_ylabel("Tokens", fontsize=11)
        ax.set_title(
            "Daily Token Consumption by Type",
            fontsize=14,
            fontweight="bold",
        )
        ax.legend(loc="upper left", fontsize=9)

        fig.tight_layout()
        if save_path:
            fig.savefig(save_path, dpi=150, bbox_inches="tight")
        return fig

    # ------------------------------------------------------------------
    # 4. Job health heatmap
    # ------------------------------------------------------------------

    def job_health_heatmap(
        self, figsize: tuple = (14, 6), save_path: Optional[str] = None
    ) -> plt.Figure:
        """Heatmap of job success rate by date (rows=jobs, cols=dates)."""
        if self.df.empty:
            return self._empty_fig("No data for heatmap")

        pivot = self.df.pivot_table(
            index="job_id",
            columns="date",
            values="status",
            aggfunc=lambda x: (x == "ok").sum() / len(x),
            fill_value=float("nan"),
        )

        fig, ax = plt.subplots(figsize=figsize, facecolor=COLORS["bg"])
        ax.set_facecolor(COLORS["bg"])

        # Custom colormap: red → yellow → green
        from matplotlib.colors import LinearSegmentedColormap
        cmap = LinearSegmentedColormap.from_list(
            "health", [COLORS["error"], COLORS["skipped"], COLORS["ok"]]
        )

        im = ax.imshow(pivot.values, cmap=cmap, aspect="auto", vmin=0, vmax=1)

        ax.set_yticks(range(len(pivot.index)))
        ax.set_yticklabels(pivot.index, fontsize=9)
        ax.set_xticks(range(len(pivot.columns)))
        ax.set_xticklabels(
            [str(d) for d in pivot.columns], rotation=45, ha="right", fontsize=8
        )

        # Annotate cells
        for i in range(len(pivot.index)):
            for j in range(len(pivot.columns)):
                val = pivot.values[i, j]
                if np.isnan(val):
                    continue
                text_color = "white" if val < 0.5 else "black"
                ax.text(
                    j, i, f"{val:.0%}",
                    ha="center", va="center",
                    fontsize=8, color=text_color, fontweight="bold",
                )

        cbar = fig.colorbar(im, ax=ax, label="Success Rate", shrink=0.8)
        cbar.set_ticks([0, 0.5, 1.0])
        cbar.set_ticklabels(["0%", "50%", "100%"])

        ax.set_title(
            "Job Health Heatmap (Success Rate by Day)",
            fontsize=14,
            fontweight="bold",
        )

        fig.tight_layout()
        if save_path:
            fig.savefig(save_path, dpi=150, bbox_inches="tight")
        return fig

    # ------------------------------------------------------------------
    # 5. Duration distribution by provider
    # ------------------------------------------------------------------

    def duration_distribution(
        self, figsize: tuple = (10, 5), save_path: Optional[str] = None
    ) -> plt.Figure:
        """Box plot of execution duration by provider."""
        if self.df.empty:
            return self._empty_fig("No data for duration distribution")

        df = self.df.dropna(subset=["duration_ms"]).copy()
        df["provider"] = df["provider"].fillna("unknown")
        df["duration_sec"] = df["duration_ms"] / 1000

        providers = df["provider"].unique()

        fig, ax = plt.subplots(figsize=figsize, facecolor=COLORS["bg"])
        ax.set_facecolor(COLORS["bg"])

        data = [df[df["provider"] == p]["duration_sec"].values for p in providers]
        bp = ax.boxplot(
            data,
            labels=providers,
            patch_artist=True,
            medianprops=dict(color="black", linewidth=2),
        )

        palette = [COLORS["primary"], COLORS["secondary"], COLORS["accent"], COLORS["ok"]]
        for i, patch in enumerate(bp["boxes"]):
            patch.set_facecolor(palette[i % len(palette)])
            patch.set_alpha(0.7)

        ax.set_ylabel("Duration (seconds)", fontsize=11)
        ax.set_title(
            "Execution Duration Distribution by Provider",
            fontsize=14,
            fontweight="bold",
        )

        fig.tight_layout()
        if save_path:
            fig.savefig(save_path, dpi=150, bbox_inches="tight")
        return fig

    # ------------------------------------------------------------------
    # 6. Delivery status breakdown
    # ------------------------------------------------------------------

    def delivery_breakdown(
        self, figsize: tuple = (7, 5), save_path: Optional[str] = None
    ) -> plt.Figure:
        """Pie chart of delivery status distribution."""
        if self.df.empty or "delivery_status" not in self.df.columns:
            return self._empty_fig("No delivery data")

        counts = self.df["delivery_status"].value_counts()

        color_map = {
            "delivered": COLORS["ok"],
            "not-delivered": COLORS["error"],
            "not-requested": "#bdc3c7",
            "unknown": COLORS["skipped"],
        }
        colors = [color_map.get(str(s), "#bdc3c7") for s in counts.index]

        fig, ax = plt.subplots(figsize=figsize, facecolor=COLORS["bg"])
        ax.set_facecolor(COLORS["bg"])

        wedges, texts, autotexts = ax.pie(
            counts.values,
            labels=[str(s) for s in counts.index],
            colors=colors,
            autopct="%1.1f%%",
            startangle=90,
            textprops={"fontsize": 10},
        )
        for autotext in autotexts:
            autotext.set_fontweight("bold")

        ax.set_title(
            "Delivery Status Breakdown",
            fontsize=14,
            fontweight="bold",
        )

        fig.tight_layout()
        if save_path:
            fig.savefig(save_path, dpi=150, bbox_inches="tight")
        return fig

    # ------------------------------------------------------------------
    # Save all charts
    # ------------------------------------------------------------------

    def save_all(self, output_dir: str = "./charts") -> list[str]:
        """Generate and save all charts to a directory. Returns list of saved file paths."""
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)

        charts = [
            ("daily_success_rate", self.daily_success_rate),
            ("model_comparison", self.model_comparison),
            ("token_usage_timeline", self.token_usage_timeline),
            ("job_health_heatmap", self.job_health_heatmap),
            ("duration_distribution", self.duration_distribution),
            ("delivery_breakdown", self.delivery_breakdown),
        ]

        saved: list[str] = []
        for name, method in charts:
            path = str(out / f"{name}.png")
            try:
                fig = method(save_path=path)
                plt.close(fig)
                saved.append(path)
                print(f"  Saved: {path}")
            except Exception as e:
                print(f"  Skipped {name}: {e}")

        print(f"\n{len(saved)} charts saved to {output_dir}/")
        return saved

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _empty_fig(message: str) -> plt.Figure:
        fig, ax = plt.subplots(figsize=(8, 3))
        ax.text(0.5, 0.5, message, ha="center", va="center", fontsize=14, color="#999")
        ax.axis("off")
        return fig


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    import argparse

    sys.path.insert(0, str(Path(__file__).parent))
    from openclaw_loader import load_cron_runs

    parser = argparse.ArgumentParser(description="Generate OpenClaw telemetry charts.")
    parser.add_argument("--dir", help="Override ~/.openclaw base directory.")
    parser.add_argument(
        "--output", default="./charts", help="Output directory for charts."
    )
    parser.add_argument("--show", action="store_true", help="Show charts interactively.")
    args = parser.parse_args()

    df = load_cron_runs(openclaw_dir=args.dir)
    if df.empty:
        print("No cron run data found. Run some cron jobs first.")
        return

    viz = CronViz(df)

    if args.show:
        viz.daily_success_rate()
        viz.model_comparison()
        viz.token_usage_timeline()
        viz.job_health_heatmap()
        viz.duration_distribution()
        viz.delivery_breakdown()
        plt.show()
    else:
        viz.save_all(args.output)


if __name__ == "__main__":
    main()
