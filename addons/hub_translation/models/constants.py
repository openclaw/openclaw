_ALLOWED_TRANSITIONS = {
    "client_submitted": {"pm_review"},
    "pm_review": {"assigned_to_translator"},
    "assigned_to_translator": {"translator_delivered"},
    "translator_delivered": {"reviewer_check"},
    "reviewer_check": {"qa_passed"},
    "qa_passed": {"ready_for_delivery"},
    "ready_for_delivery": {"delivered"},
    "delivered": {"invoicing"},
    "invoicing": set(),
}


_STAGE_ROLE_MAP = {
    "pm_review": "hub_translation.group_pm",
    "assigned_to_translator": "hub_translation.group_pm",
    "translator_delivered": "hub_translation.group_translator",
    "reviewer_check": "hub_translation.group_reviewer",
    "qa_passed": "hub_translation.group_qa",
    "ready_for_delivery": "hub_translation.group_pm",
    "delivered": "hub_translation.group_pm",
    "invoicing": "hub_translation.group_finance",
}

