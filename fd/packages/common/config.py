from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    ENV: str = "dev"
    DRY_RUN: bool = True
    READ_ONLY: bool = False
    KILL_SWITCH: bool = False
    SAFE_MODE: bool = True

    WEBHOOK_SHARED_SECRET: str = ""
    BOOKING_LINK: str = ""

    SQLITE_PATH: str = "./data/app.db"

    GHL_API_KEY: str = ""
    GHL_BASE_URL: str = "https://rest.gohighlevel.com"
    GHL_PIPELINE_ID: str = ""
    GHL_STAGE_NEW_ID: str = ""
    GHL_STAGE_WON_ID: str = ""
    TAG_LEAD: str = "lead"
    TAG_CUTMV: str = "cutmv"
    TAG_FULLDIGITAL: str = "fulldigital"

    GHL_CUSTOM_FIELD_TRELLO_BOARD_ID_KEY: str = "TrelloBoardId"
    GHL_CUSTOM_FIELD_TRELLO_PRIMARY_CARD_ID_KEY: str = "TrelloPrimaryCardId"

    MANYCHAT_API_KEY: str = ""
    MANYCHAT_BASE_URL: str = "https://api.manychat.com"

    ADMIN_OPS_TOKEN: str = ""

    CHECKOUT_SUCCESS_URL: str = ""
    CHECKOUT_CANCEL_URL: str = ""

    STRIPE_SECRET_KEY: str = ""
    STRIPE_WEBHOOK_SECRET: str = ""
    STRIPE_SUCCESS_URL: str = "https://example.com/success"
    STRIPE_CANCEL_URL: str = "https://example.com/cancel"

    STRIPE_PRICE_ID_FD_ROLLOUT_800: str = ""
    STRIPE_PRICE_ID_FD_SUB_1500: str = ""
    STRIPE_PRICE_ID_CUTMV_PRO: str = ""

    TRELLO_KEY: str = ""
    TRELLO_TOKEN: str = ""
    TRELLO_WORKSPACE_ID: str = ""
    TRELLO_TEMPLATE_BOARD_ID: str = ""

    TRELLO_WEBHOOK_SECRET: str = ""

    PUBLIC_BASE_URL: str = ""
    PUBLIC_WEBHOOK_BASE_URL: str = ""
    TRELLO_AUTO_WEBHOOK_ENABLED: bool = True

    GHL_WEBHOOK_SHARED_SECRET: str = ""
    GHL_LOCATION_ID: str = ""
    GHL_DEFAULT_OPPORTUNITY_STAGE: str = "Intake"
    GHL_TRELLO_BOARD_ID_CUSTOM_FIELD_KEY: str = ""
    GHL_TRELLO_WEBHOOK_ID_CUSTOM_FIELD_KEY: str = ""

    # GHL custom field keys
    GHL_DROPBOX_FOLDER_URL_CUSTOM_FIELD_KEY: str = ""

    # Trello reference card names (v1 defaults)
    TRELLO_REFERENCE_CARD_DROPBOX_NAME: str = "Dropbox folder (assets + deliverables)"
    TRELLO_REFERENCE_CARD_START_HERE_NAME: str = "START HERE"

    CLEANUP_ON_GHL_STAGE_IDS_JSON: str = "[]"
    CLEANUP_ON_TRELLO_LIST_NAMES_JSON: str = "[]"
    TRELLO_CLOSE_BOARD_ON_CLEANUP: bool = False
    TRELLO_MOVE_PRIMARY_CARD_ON_CLEANUP: bool = True
    TRELLO_ARCHIVE_LIST_NAME: str = "Archived"
    TRELLO_AUTOCREATE_ARCHIVE_LIST_ON_CLEANUP: bool = True
    TRELLO_APPLY_ARCHIVED_LABEL_ON_CLEANUP: bool = True
    TRELLO_AUTOCREATE_ARCHIVED_LABEL_ON_CLEANUP: bool = True
    TRELLO_ARCHIVED_LABEL_NAME: str = "Archived"
    TRELLO_ADD_CLEANUP_COMMENT_ON_CLEANUP: bool = True
    OFFER_CLEANUP_CLOSE_BOARD_JSON: str = "{}"

    INTERNAL_FULFILLMENT_TRELLO_BOARD_ID: str = ""
    INTERNAL_FULFILLMENT_INBOX_LIST_NAME: str = "Inbox"
    INTERNAL_FULFILLMENT_AUTOCREATE_LISTS: bool = True
    INTERNAL_FULFILLMENT_LISTS_JSON: str = "[]"

    GHL_INTAKE_WEBHOOK_SECRET: str = ""
    MANYCHAT_INTAKE_WEBHOOK_SECRET: str = ""

    REQUEST_ROUTING_RULES_JSON: str = "{}"

    AUTO_CREATE_CLIENT_REQUEST_CARD: bool = True
    CLIENT_REQUEST_LIST_NAME: str = "Requests"

    CLIENT_REQUEST_LIST_NAMES_JSON: str = '["Requests"]'
    CLIENT_IN_PROGRESS_LIST_NAMES_JSON: str = '["In Progress"]'
    CLIENT_NEEDS_REVIEW_LIST_NAMES_JSON: str = '["Needs Review / Feedback"]'
    CLIENT_APPROVED_READY_LIST_NAMES_JSON: str = '["Approved / Ready for Delivery"]'
    CLIENT_PUBLISHED_LIST_NAMES_JSON: str = '["Published / Delivered"]'
    CLIENT_REFERENCE_LIST_NAMES_JSON: str = '["Reference & Links"]'

    TRELLO_AUTO_AR_LABELS: bool = True

    ASSIGNMENT_MIRROR_TO_TRELLO_LABEL: bool = True
    ASSIGNMENT_LABEL_PREFIX: str = "Assigned:"
    ASSIGNMENT_MIRROR_TO_TIMELINE: bool = True
    ASSIGNMENT_PREFIX_CARD_TITLE: bool = False

    TIMELINE_LOG_ENABLED: bool = True
    TIMELINE_JSON_MARKER: str = "[OPENCLAW_JSON]"
    TIMELINE_ALLOWED_EVENT_TYPES_JSON: str = "[]"

    STAGE_TO_TRELLO_LIST_JSON: str = "{}"
    TRELLO_LIST_TO_STAGE_JSON: str = "{}"

    STAGE_SYNC_ECHO_SUPPRESS_SECONDS: int = 90

    OFFER_CURRENCY: str = "usd"

    TRELLO_CLIENT_BOARD_ORG_ID: str = ""
    TRELLO_CLIENT_BOARD_VISIBILITY: str = "private"

    # Marker tokens (canonical desc blocks)
    MARKER_BEGIN_LINKS_JSON: str = "BEGIN_LINKS_JSON"
    MARKER_END_LINKS_JSON: str = "END_LINKS_JSON"

    MARKER_BEGIN_DELIVERY_LINKS: str = "BEGIN_DELIVERY_LINKS"
    MARKER_END_DELIVERY_LINKS: str = "END_DELIVERY_LINKS"

    MARKER_BEGIN_LINKS_HUMAN: str = "BEGIN_LINKS_HUMAN"
    MARKER_END_LINKS_HUMAN: str = "END_LINKS_HUMAN"

    MARKER_BEGIN_CLEANUP_SUMMARY: str = "BEGIN_CLEANUP_SUMMARY"
    MARKER_END_CLEANUP_SUMMARY: str = "END_CLEANUP_SUMMARY"

    MARKER_BEGIN_SYNC_STATE: str = "BEGIN_SYNC_STATE"
    MARKER_END_SYNC_STATE: str = "END_SYNC_STATE"

    # Human summary behavior
    LINKS_HUMAN_MAX_PER_ROLE: int = 1
    LINKS_HUMAN_MAX_TOTAL: int = 4

    # Feature toggles (all respect SAFE_MODE/DRY_RUN for Trello mutations)
    AUTO_MOVE_DRAFT_TO_NEEDS_REVIEW: bool = True
    AUTO_MOVE_FINAL_TO_PUBLISHED: bool = True
    AUTO_TOGGLE_DUECOMPLETE_ON_REVISION: bool = True
    AUTO_PUBLISH_ON_RELEASE_DATE: bool = True
    AUTO_CLIENT_REMINDERS: bool = False

    # Job runner safety + throughput defaults
    JOB_BATCH_LIMIT: int = 75
    JOB_MAX_RUNTIME_SECONDS: int = 18
    JOB_MAX_ERRORS_PER_RUN: int = 5

    # Trello request policy (wrapper already retries; these tune job behavior)
    TRELLO_JOB_MAX_MUTATIONS_PER_RUN: int = 60
    TRELLO_JOB_MAX_READS_PER_RUN: int = 120
    RETRY_QUEUE_ENABLED: bool = True

    # Cooldown policy (global circuit breaker)
    COOLDOWN_FAILS_BEFORE_TRIP: int = 4
    COOLDOWN_BASE_SECONDS: int = 300
    COOLDOWN_MAX_SECONDS: int = 3600

    # Health endpoint warning thresholds
    HEALTH_WARN_QUEUE_DEPTH_THRESHOLD: int = 500
    HEALTH_WARN_RECONCILE_STALE_HOURS: int = 24

    # Notion AgencyOS
    NOTION_API_KEY: str = ""
    NOTION_ROOT_PAGE_ID: str = ""
    NOTION_WRITE_ENABLED: bool = False
    NOTION_WRITE_LOCK: bool = False  # Emergency: blocks ALL Notion mutations

    # Skills backlog + checklists
    NOTION_DB_SKILLS_BACKLOG_ID: str = ""
    NOTION_PAGE_SKILLS_CHECKLISTS_ROOT_ID: str = ""
    NOTION_PAGE_DB_ROOT_ID: str = ""

    # Google Calendar (service account + domain-wide delegation on fulldigitalll.com)
    GOOGLE_WORKSPACE_DOMAIN: str = "fulldigitalll.com"
    GOOGLE_SERVICE_ACCOUNT_KEY_PATH: str = ""
    GOOGLE_IMPERSONATE_EMAIL: str = "calendar-bot@fulldigitalll.com"
    GOOGLE_CALENDAR_ID: str = "primary"
    GCAL_CALENDAR_IDS_JSON: str = '["primary"]'
    GCAL_WRITE_ENABLED: bool = False
    GCAL_WRITE_TRELLO_DUE: bool = False

    # Schedule sync
    SCHEDULE_SYNC_WINDOW_PAST_DAYS: int = 7
    SCHEDULE_SYNC_WINDOW_FUTURE_DAYS: int = 30

    # Today panel focus window
    TODAY_FOCUS_WINDOW_HOURS: int = 10
    TODAY_TIMEZONE: str = "America/New_York"
    TODAY_INCLUDE_ALL_DAY_DEADLINES: bool = True
    TODAY_ALL_DAY_TYPE_ALLOWLIST: str = "deadline"
    TODAY_MAX_ITEMS: int = 12

    # ClickFunnels
    CLICKFUNNELS_WEBHOOK_SECRET: str = ""

    SENTRY_DSN: str = ""
    POSTHOG_API_KEY: str = ""
    POSTHOG_HOST: str = "https://app.posthog.com"

    # WebOps provider tokens (used by packages/webops/drift/detector.py)
    CLOUDFLARE_API_TOKEN: str = ""
    VERCEL_API_TOKEN: str = ""
    WEBFLOW_API_TOKEN: str = ""
    GA4_API_KEY: str = ""

    # GrantOps (Finance sub-module)
    GRANTOPS_ENABLED: bool = False
    GRANTOPS_AUTO_SUBMIT_ENABLED: bool = False
    GRANTOPS_FIT_SCORE_THRESHOLD: float = 0.7
    GRANTOPS_MAX_SUBMISSIONS_PER_DAY: int = 3
    GRANTOPS_REQUIRE_TELEGRAM_APPROVAL: bool = True
    GRANTOPS_DAILY_SCAN_HOUR: int = 6
    GRANTOPS_DAILY_SCAN_TIMEZONE: str = "America/New_York"

    # Candid API
    CANDID_API_KEY: str = ""
    CANDID_BASE_URL: str = "https://api.candid.org/grants/v1"

    # Submittable API
    SUBMITTABLE_API_KEY: str = ""
    SUBMITTABLE_ORG_ID: str = ""
    SUBMITTABLE_BASE_URL: str = "https://api.submittable.com/v4"

    # Notion DB IDs for GrantOps
    NOTION_DB_GRANT_OPPORTUNITIES_ID: str = ""
    NOTION_DB_GRANT_DRAFTS_ID: str = ""
    NOTION_DB_GRANT_SUBMISSIONS_ID: str = ""


settings = Settings()
