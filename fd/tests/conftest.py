from __future__ import annotations

import os

# Set env vars at module level BEFORE any import triggers Settings() creation.
# conftest.py is imported by pytest before test modules, so this ensures
# settings = Settings() picks up these values.
os.environ.setdefault("WEBHOOK_SHARED_SECRET", "test-secret")
os.environ.setdefault("BOOKING_LINK", "https://example.com/book")
os.environ.setdefault("SQLITE_PATH", "./data/test.db")
os.environ.setdefault("DRY_RUN", "true")
os.environ.setdefault("READ_ONLY", "false")
os.environ.setdefault("KILL_SWITCH", "false")
os.environ.setdefault("ADMIN_OPS_TOKEN", "admin-secret")
os.environ.setdefault("CHECKOUT_SUCCESS_URL", "https://example.com/success")
os.environ.setdefault("CHECKOUT_CANCEL_URL", "https://example.com/cancel")
os.environ.setdefault("STRIPE_PRICE_ID_FD_ROLLOUT_800", "price_test_800")
os.environ.setdefault("STRIPE_PRICE_ID_FD_SUB_1500", "price_test_1500")
os.environ.setdefault("STRIPE_PRICE_ID_CUTMV_PRO", "price_test_cutmv")
os.environ.setdefault("TRELLO_KEY", "trello_key")
os.environ.setdefault("TRELLO_TOKEN", "trello_token")
os.environ.setdefault("TRELLO_WORKSPACE_ID", "trello_org")
os.environ.setdefault("TRELLO_TEMPLATE_BOARD_ID", "trello_template")
os.environ.setdefault("TRELLO_WEBHOOK_SECRET", "trello-secret")
os.environ.setdefault("GHL_WEBHOOK_SHARED_SECRET", "ghl-secret")
os.environ.setdefault("STAGE_TO_TRELLO_LIST_JSON", '{"stage_new":"Awaiting Details","stage_won":"Published/Delivered"}')
os.environ.setdefault("TRELLO_LIST_TO_STAGE_JSON", '{"Awaiting Details":"stage_new","Published/Delivered":"stage_won"}')

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def set_env(tmp_path):  # noqa: ARG001
    os.environ["WEBHOOK_SHARED_SECRET"] = "test-secret"
    os.environ["BOOKING_LINK"] = "https://example.com/book"
    os.environ["DRY_RUN"] = "true"
    os.environ["READ_ONLY"] = "false"
    os.environ["KILL_SWITCH"] = "false"
    os.environ["ADMIN_OPS_TOKEN"] = "admin-secret"
    os.environ["CHECKOUT_SUCCESS_URL"] = "https://example.com/success"
    os.environ["CHECKOUT_CANCEL_URL"] = "https://example.com/cancel"
    os.environ["STRIPE_PRICE_ID_FD_ROLLOUT_800"] = "price_test_800"
    os.environ["STRIPE_PRICE_ID_FD_SUB_1500"] = "price_test_1500"
    os.environ["STRIPE_PRICE_ID_CUTMV_PRO"] = "price_test_cutmv"
    os.environ["TRELLO_KEY"] = "trello_key"
    os.environ["TRELLO_TOKEN"] = "trello_token"
    os.environ["TRELLO_WORKSPACE_ID"] = "trello_org"
    os.environ["TRELLO_TEMPLATE_BOARD_ID"] = "trello_template"
    os.environ["TRELLO_WEBHOOK_SECRET"] = "trello-secret"
    os.environ["GHL_WEBHOOK_SHARED_SECRET"] = "ghl-secret"
    os.environ["STAGE_TO_TRELLO_LIST_JSON"] = '{"stage_new":"Awaiting Details","stage_won":"Published/Delivered"}'
    os.environ["TRELLO_LIST_TO_STAGE_JSON"] = '{"Awaiting Details":"stage_new","Published/Delivered":"stage_won"}'
    yield
