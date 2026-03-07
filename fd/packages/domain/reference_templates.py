from __future__ import annotations

from dataclasses import dataclass

# ---------------------------------------------------------------------------
# Default reference card templates seeded on every new client board.
# Each template becomes a card in the "Reference & Links" list.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ReferenceTemplate:
    name: str
    desc: str


DEFAULT_REFERENCE_TEMPLATES: list[ReferenceTemplate] = [
    ReferenceTemplate(
        name="Brand Guidelines",
        desc=(
            "Attach brand kit, color palette, font files, and any "
            "do/don't usage rules here.\n\n"
            "Tip: Use Trello attachments or paste a link to your "
            "Google Drive / Dropbox folder."
        ),
    ),
    ReferenceTemplate(
        name="Logo Files",
        desc=(
            "Upload all logo variations: full color, reversed, "
            "icon-only, wordmark.\n\n"
            "Preferred formats: SVG, PNG (transparent), AI/EPS."
        ),
    ),
    ReferenceTemplate(
        name="Social Media Accounts",
        desc=(
            "List your social handles and links here.\n\n"
            "- Instagram: \n- Facebook: \n- TikTok: \n- LinkedIn: \n- X/Twitter: \n"
        ),
    ),
    ReferenceTemplate(
        name="Content Calendar / Schedule",
        desc=(
            "Attach or link your content calendar so designers "
            "know upcoming deadlines.\n\n"
            "Google Sheets / Notion links work great."
        ),
    ),
    ReferenceTemplate(
        name="Inspiration & Moodboard",
        desc=(
            "Drop competitor examples, Pinterest boards, or "
            "screenshots of styles you like.\n\n"
            "The more visual context, the better the output."
        ),
    ),
    ReferenceTemplate(
        name="Dropbox folder (assets + deliverables)",
        desc=(
            "Shared Dropbox folder for assets and deliverables.\n\n"
            "If a Dropbox link is configured in GHL, it will be "
            "auto-synced into this card's description."
        ),
    ),
    ReferenceTemplate(
        name="Onboarding / Retainer Terms",
        desc=(
            "Attach your onboarding paperwork, retainer agreement, "
            "or service terms here.\n\n"
            "This keeps everything in one place for reference."
        ),
    ),
    ReferenceTemplate(
        name="Release Schedule / Links",
        desc=(
            "Post your weekly or monthly release schedule here.\n\n"
            "Include dates, platforms, and any relevant links.\n"
            "Google Sheets / Notion links work great."
        ),
    ),
    ReferenceTemplate(
        name="Brand / Roster Assets",
        desc=(
            "Upload roster headshots, team photos, event photos, "
            "and other brand-specific assets here.\n\n"
            "Organize by date or category in subfolders."
        ),
    ),
    ReferenceTemplate(
        name="Communication Rules",
        desc=(
            "How to communicate on this board:\n\n"
            "- Card descriptions: canonical info (links, specs, deadlines)\n"
            "- Comments: feedback, revisions, approvals\n"
            "- Attachments: files too large for description\n"
            "- Checklists: deliverables tracking\n\n"
            "Keep descriptions clean; use comments for conversation."
        ),
    ),
]
