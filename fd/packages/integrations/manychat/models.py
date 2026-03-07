from __future__ import annotations

from pydantic import BaseModel


class ManyChatSendText(BaseModel):
    subscriber_id: str
    text: str


class ManyChatIncoming(BaseModel):
    # minimal intake payload for our gateway
    instagram_handle: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    email: str | None = None
    phone: str | None = None
    subscriber_id: str | None = None
    brand: str = "fulldigital"
    keyword: str | None = None
    answers: dict = {}
    event_id: str | None = None
