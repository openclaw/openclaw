"""LINE Flex Message formatter for analysis reports."""

from __future__ import annotations

from ..models import AnalysisResult


def _signal_emoji(action: str) -> str:
    lower = action.lower()
    if lower == "buy":
        return "\U0001f7e2"  # green circle
    if lower == "sell":
        return "\U0001f534"  # red circle
    return "\U0001f7e1"  # yellow circle


def _sentiment_emoji(label: str) -> str:
    lower = label.lower()
    if lower == "bullish":
        return "\U0001f4c8"  # chart up
    if lower == "bearish":
        return "\U0001f4c9"  # chart down
    return "\u2796"  # minus


def format_line(analysis: AnalysisResult) -> dict:
    """Format analysis as a LINE Flex Message.

    Mobile-friendly: 3-line summary first, then details in a compact card.
    """
    # Build 3-line summary (shown at top, easy to read on mobile)
    lines: list[str] = [f"\U0001f4ca {analysis.symbol} Analysis"]

    if analysis.market_data and analysis.market_data.price is not None:
        md = analysis.market_data
        change = f" ({md.change_pct:+.1f}%)" if md.change_pct is not None else ""
        lines.append(f"\U0001f4b0 ${md.price:,.2f}{change}")

    if analysis.signals and analysis.signals.action:
        sig = analysis.signals
        emoji = _signal_emoji(sig.action)
        lines.append(f"{emoji} {sig.action} | Risk: {sig.risk_level}")

    summary_text = "\n".join(lines)

    # Build detail body contents for Flex Message
    body_contents: list[dict] = []

    # Market data
    if analysis.market_data:
        md = analysis.market_data
        details = []
        if md.rsi is not None:
            details.append(f"RSI: {md.rsi:.1f}")
        if md.pe_ratio is not None:
            details.append(f"P/E: {md.pe_ratio:.1f}")
        if md.volume is not None:
            details.append(f"Vol: {md.volume:,}")
        if details:
            body_contents.append(_text_component(" | ".join(details), size="sm", color="#666666"))

    # Sentiment
    if analysis.sentiment:
        s = analysis.sentiment
        emoji = _sentiment_emoji(s.label)
        body_contents.append(
            _text_component(f"{emoji} Sentiment: {s.score:+.2f} ({s.label})", size="sm")
        )
        if s.summary:
            body_contents.append(_text_component(s.summary, size="xs", color="#888888"))

    # Signals detail
    if analysis.signals:
        sig = analysis.signals
        parts = []
        if sig.entry_price is not None:
            parts.append(f"Entry ${sig.entry_price:,.2f}")
        if sig.stop_loss is not None:
            parts.append(f"SL ${sig.stop_loss:,.2f}")
        if sig.take_profit is not None:
            parts.append(f"TP ${sig.take_profit:,.2f}")
        if parts:
            body_contents.append(_text_component(" | ".join(parts), size="xs", color="#666666"))

    # Divergence warning
    if analysis.divergence_warning:
        body_contents.append(
            _text_component(f"\u26a0\ufe0f {analysis.divergence_detail}", size="sm", color="#e01e5a")
        )

    # Source errors
    if analysis.source_errors:
        err = ", ".join(e.service for e in analysis.source_errors)
        body_contents.append(_text_component(f"\u274c Unavailable: {err}", size="xs", color="#999999"))

    return {
        "type": "flex",
        "altText": summary_text,
        "contents": {
            "type": "bubble",
            "size": "kilo",
            "header": {
                "type": "box",
                "layout": "vertical",
                "contents": [
                    _text_component(f"{analysis.symbol} Report", size="lg", weight="bold"),
                    _text_component(analysis.synthesis, size="xs", color="#888888", wrap=True),
                ],
            },
            "body": {
                "type": "box",
                "layout": "vertical",
                "spacing": "sm",
                "contents": body_contents or [_text_component("No data available", size="sm")],
            },
            "footer": {
                "type": "box",
                "layout": "vertical",
                "contents": [
                    _text_component(f"B-FIA | {analysis.generated_at}", size="xxs", color="#aaaaaa"),
                ],
            },
        },
    }


def _text_component(
    text: str,
    *,
    size: str = "md",
    color: str | None = None,
    weight: str | None = None,
    wrap: bool = True,
) -> dict:
    """Build a LINE Flex text component."""
    comp: dict = {"type": "text", "text": text, "size": size, "wrap": wrap}
    if color:
        comp["color"] = color
    if weight:
        comp["weight"] = weight
    return comp
