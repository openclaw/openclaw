"""Slack Block Kit formatter for analysis reports."""

from __future__ import annotations

from ..models import AnalysisResult


def _signal_color(action: str) -> str:
    """Map signal action to Slack attachment color."""
    lower = action.lower()
    if lower == "buy":
        return "#2eb886"  # green
    if lower == "sell":
        return "#e01e5a"  # red
    return "#daa038"  # amber


def format_slack(analysis: AnalysisResult) -> dict:
    """Format analysis as Slack Block Kit payload."""
    blocks: list[dict] = []

    # Header
    blocks.append({
        "type": "header",
        "text": {"type": "plain_text", "text": f"B-FIA Report: {analysis.symbol}"},
    })

    # Market Data section
    if analysis.market_data:
        md = analysis.market_data
        fields = []
        if md.price is not None:
            change = f" ({md.change_pct:+.2f}%)" if md.change_pct is not None else ""
            fields.append(f"*Price:* ${md.price:,.2f}{change}")
        if md.rsi is not None:
            fields.append(f"*RSI (14):* {md.rsi:.1f}")
        if md.volume is not None:
            fields.append(f"*Volume:* {md.volume:,}")
        if md.pe_ratio is not None:
            fields.append(f"*P/E:* {md.pe_ratio:.2f}")
        if md.market_cap is not None:
            fields.append(f"*Market Cap:* ${md.market_cap:,.0f}")

        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": "*Market Data (OpenBB)*\n" + "\n".join(fields)},
        })

    # Sentiment section
    if analysis.sentiment:
        s = analysis.sentiment
        text = f"*Sentiment (FinGPT)*\nScore: `{s.score:+.2f}` ({s.label})"
        if s.summary:
            text += f"\n{s.summary}"
        if s.headlines:
            text += "\n_Headlines:_\n" + "\n".join(f"- {h}" for h in s.headlines[:3])
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": text}})

    # Signals section
    if analysis.signals:
        sig = analysis.signals
        text = f"*Trade Signal (QuantAgent)*\nAction: *{sig.action}* (confidence: {sig.confidence:.0%})"
        if sig.entry_price is not None:
            text += f"\nEntry: ${sig.entry_price:,.2f}"
        if sig.stop_loss is not None:
            text += f" | SL: ${sig.stop_loss:,.2f}"
        if sig.take_profit is not None:
            text += f" | TP: ${sig.take_profit:,.2f}"
        if sig.risk_level:
            text += f"\nRisk: {sig.risk_level}"
        if sig.rationale:
            text += f"\n_{sig.rationale}_"
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": text}})

    # Divergence warning
    if analysis.divergence_warning:
        blocks.append({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f":warning: *{analysis.divergence_detail}*",
            },
        })

    # Synthesis
    blocks.append({"type": "divider"})
    blocks.append({
        "type": "section",
        "text": {"type": "mrkdwn", "text": f"*Summary:* {analysis.synthesis}"},
    })

    # Source errors
    if analysis.source_errors:
        err_text = "\n".join(f":x: {e.service}: {e.error}" for e in analysis.source_errors)
        blocks.append({
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"_Data gaps:_\n{err_text}"}],
        })

    # Timestamp
    blocks.append({
        "type": "context",
        "elements": [{"type": "mrkdwn", "text": f"Generated: {analysis.generated_at}"}],
    })

    # Build final payload with color sidebar
    color = "#cccccc"
    if analysis.signals and analysis.signals.action:
        color = _signal_color(analysis.signals.action)

    return {
        "attachments": [{"color": color, "blocks": blocks}],
    }
