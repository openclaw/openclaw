#!/usr/bin/env python3
"""Refresh aggregate CSVs used by the MoClaw operating dashboard.

The script writes aggregate daily rows only. It does not persist user ids,
emails, Stripe ids, cookies, or raw event payloads.
"""

from __future__ import annotations

import csv
import datetime as dt
import json
import os
import re
import subprocess
from collections import defaultdict
from pathlib import Path
from typing import Any

import requests


ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "generated_posthog_metrics"
POSTHOG_URL = "https://us.posthog.com/api/projects/300384/query/"
GOOGLE_ADS_CUSTOMER_ID = os.environ.get("GOOGLE_ADS_CUSTOMER_ID", "6592397427")
NEW_UV_CHANNELS = [
    "Direct",
    "SEO / Organic Search",
    "Organic Social",
    "Referral",
    "Google Ads",
    "Meta Ads",
]
CHANNEL_CASE = """
CASE
  WHEN lower(coalesce(toString(properties.$session_entry_utm_source), toString(properties.utm_source), '')) LIKE '%google%'
       AND lower(coalesce(toString(properties.$session_entry_utm_medium), toString(properties.utm_medium), '')) IN ('cpc','cp','paid','ppc') THEN 'Google Ads'
  WHEN isNotNull(properties.$session_entry_gclid) OR isNotNull(properties.gclid) THEN 'Google Ads'
  WHEN (
       lower(coalesce(toString(properties.$session_entry_utm_source), toString(properties.utm_source), '')) LIKE '%meta%'
       OR lower(coalesce(toString(properties.$session_entry_utm_source), toString(properties.utm_source), '')) LIKE '%facebook%'
       OR isNotNull(properties.fbclid)
       )
       AND lower(coalesce(toString(properties.$session_entry_utm_medium), toString(properties.utm_medium), '')) IN ('cpc','cp','paid','ppc') THEN 'Meta Ads'
  WHEN lower(coalesce(toString(properties.$session_entry_utm_medium), toString(properties.utm_medium), '')) IN ('social','organic_social') THEN 'Organic Social'
  WHEN lower(coalesce(toString(properties.$session_entry_referring_domain), toString(properties.$referring_domain), '')) LIKE '%twitter%'
       OR lower(coalesce(toString(properties.$session_entry_referring_domain), toString(properties.$referring_domain), '')) LIKE '%t.co%'
       OR lower(coalesce(toString(properties.$session_entry_referring_domain), toString(properties.$referring_domain), '')) LIKE '%reddit%'
       OR lower(coalesce(toString(properties.$session_entry_referring_domain), toString(properties.$referring_domain), '')) LIKE '%producthunt%'
       OR lower(coalesce(toString(properties.$session_entry_referring_domain), toString(properties.$referring_domain), '')) LIKE '%tiktok%'
       OR lower(coalesce(toString(properties.$session_entry_referring_domain), toString(properties.$referring_domain), '')) LIKE '%youtube%'
       OR lower(coalesce(toString(properties.$session_entry_referring_domain), toString(properties.$referring_domain), '')) LIKE '%linkedin%'
       OR lower(coalesce(toString(properties.$session_entry_referring_domain), toString(properties.$referring_domain), '')) LIKE '%facebook%'
       OR lower(coalesce(toString(properties.$session_entry_referring_domain), toString(properties.$referring_domain), '')) LIKE '%instagram%' THEN 'Organic Social'
  WHEN isNotNull(properties.$session_entry_search_engine) OR isNotNull(properties.$search_engine) THEN 'SEO / Organic Search'
  WHEN coalesce(toString(properties.$session_entry_referring_domain), toString(properties.$referring_domain), '') IN ('', '$direct') THEN 'Direct'
  WHEN coalesce(toString(properties.$session_entry_referring_domain), toString(properties.$referring_domain), '') LIKE '%moclaw.ai%' THEN 'Direct'
  WHEN isNotNull(properties.$session_entry_referring_domain) OR isNotNull(properties.$referring_domain) THEN 'Referral'
  ELSE 'Unrecognized UTM'
END
"""
START = dt.date(2026, 5, 15)
END_EXCLUSIVE = dt.date(2026, 5, 26)
END_AT_BJT = dt.datetime(2026, 5, 25, 22, 0, 0)
TZ = "Asia/Shanghai"
START_UTC = dt.datetime(2026, 5, 14, 16, 0, 0)
END_UTC = dt.datetime(2026, 5, 25, 14, 0, 0)
LAST_COMPLETE_BJT_DAY = END_AT_BJT.date() - dt.timedelta(days=1)


def date_range() -> list[str]:
    days = []
    day = START
    while day < END_EXCLUSIVE:
        days.append(day.isoformat())
        day += dt.timedelta(days=1)
    return days


DAYS = date_range()


def local_secret(name: str, pattern: str) -> str:
    value = os.environ.get(name)
    if value:
        return value
    for candidate in [ROOT / "build_v10.py", ROOT / "build_v9.py"]:
        if not candidate.exists():
            continue
        match = re.search(pattern, candidate.read_text())
        if match:
            return match.group(1)
    raise SystemExit(f"{name} is required")


def posthog_key() -> str:
    return local_secret("POSTHOG_API_KEY", r"PH='([^']+)'")


def stripe_key() -> str:
    return local_secret("STRIPE_SECRET_KEY", r"SK='([^']+)'")


def hogql(sql: str) -> list[list[Any]]:
    response = requests.post(
        POSTHOG_URL,
        headers={"Authorization": f"Bearer {posthog_key()}"},
        json={"query": {"kind": "HogQLQuery", "query": sql}},
        timeout=240,
    )
    if response.status_code != 200:
        raise RuntimeError(f"PostHog query failed: {response.status_code} {response.text[:1200]}")
    return response.json()["results"]


def write_csv(name: str, header: list[str], rows: list[list[Any]]) -> Path:
    OUT_DIR.mkdir(exist_ok=True)
    path = OUT_DIR / name
    by_date = {str(row[0])[:10]: row for row in rows if row}
    full_rows = []
    for day in DAYS:
        full_rows.append(by_date.get(day, [day] + [0] * (len(header) - 1)))
    with path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(full_rows)
    return path


def write_raw_csv(name: str, header: list[str], rows: list[list[Any]]) -> Path:
    OUT_DIR.mkdir(exist_ok=True)
    path = OUT_DIR / name
    with path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)
    return path


def pull_google_ads_daily() -> Path:
    raw = subprocess.check_output(
        [
            "google-ads-open-cli",
            "campaign-stats",
            GOOGLE_ADS_CUSTOMER_ID,
            "--start",
            START.isoformat(),
            "--end",
            (END_EXCLUSIVE - dt.timedelta(days=1)).isoformat(),
            "--format",
            "json",
        ],
        text=True,
    )
    payload = json.loads(raw)
    by_date: dict[str, dict[str, float]] = defaultdict(
        lambda: {
            "spend": 0.0,
            "impressions": 0.0,
            "clicks": 0.0,
            "conversions": 0.0,
            "all_conversions": 0.0,
        }
    )
    for block in payload:
        for row in block.get("results", []):
            day = str(row.get("segments", {}).get("date", ""))[:10]
            if not day:
                continue
            metrics = row.get("metrics", {})
            bucket = by_date[day]
            bucket["spend"] += to_number(metrics.get("costMicros")) / 1_000_000
            bucket["impressions"] += to_number(metrics.get("impressions"))
            bucket["clicks"] += to_number(metrics.get("clicks"))
            bucket["conversions"] += to_number(metrics.get("conversions"))
            bucket["all_conversions"] += to_number(metrics.get("allConversions"))

    rows = []
    for day in sorted(by_date):
        values = by_date[day]
        impressions = values["impressions"]
        clicks = values["clicks"]
        spend = values["spend"]
        rows.append(
            [
                day,
                round(spend, 2),
                int(impressions),
                int(clicks),
                clicks / impressions if impressions else 0,
                round(spend / clicks, 4) if clicks else 0,
                round(spend / impressions * 1000, 4) if impressions else 0,
                values["conversions"],
                values["all_conversions"],
            ]
        )
    return write_csv(
        f"google_ads_daily_{START}_{END_EXCLUSIVE}.csv",
        [
            "date",
            "spend",
            "impressions",
            "clicks",
            "ctr",
            "cpc",
            "cpm",
            "conversions",
            "all_conversions",
        ],
        rows,
    )


def to_number(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    return float(value)


def pull_agent_quality() -> Path:
    rows = hogql(
        f"""
        SELECT
          toDate(toTimeZone(timestamp, '{TZ}')) AS date,
          countIf(event='chat:session_start') AS chat_sessions,
          count(DISTINCT if(event='chat:session_start', person_id, NULL)) AS chat_session_users,
          countIf(event='chat:message_sent') AS messages,
          count(DISTINCT if(event='chat:message_sent', person_id, NULL)) AS message_users,
          countIf(event='chat:response_received') AS responses,
          if(messages = 0, 0, responses / messages) AS response_per_message,
          countIf(event IN ('chat:response_aborted','chat.stream.errored','chat.stream.aborted')) AS stream_errors,
          countIf(event='error:message_failed') AS message_failed,
          if(messages = 0, 0, message_failed / messages) AS message_failed_per_message,
          countIf(event='llm:request_completed') AS llm_total,
          countIf(event='llm:request_completed' AND toInt(properties.status_code) >= 200 AND toInt(properties.status_code) < 300) AS llm_2xx,
          countIf(event='llm:request_completed' AND (toInt(properties.status_code) < 200 OR toInt(properties.status_code) >= 300)) AS llm_4xx_5xx,
          if(llm_total = 0, 0, llm_2xx / llm_total) AS llm_2xx_rate,
          count(DISTINCT if(event='llm:request_completed', person_id, NULL)) AS llm_users,
          countIf(event='llm:request_completed' AND toBool(properties.has_tools)) AS requests_with_tools_available,
          countIf(event='llm:request_completed' AND toFloat(properties.tool_use_count) > 0) AS requests_with_tool_use,
          if(requests_with_tools_available = 0, 0, requests_with_tool_use / requests_with_tools_available) AS tool_use_request_rate,
          sumIf(toFloat(properties.tool_use_count), event='llm:request_completed') AS tool_use_count,
          countIf(event='llm:request_completed' AND toBool(properties.has_tool_result)) AS requests_with_tool_result_context,
          sumIf(toFloat(properties.tool_result_count), event='llm:request_completed') AS tool_result_context_count,
          sumIf(toFloat(properties.credits_consumed), event='llm:request_completed') AS credits,
          if(message_users = 0, 0, credits / message_users) AS credits_per_message_user,
          sumIf(toFloat(properties.input_tokens), event='llm:request_completed') AS input_tokens,
          sumIf(toFloat(properties.output_tokens), event='llm:request_completed') AS output_tokens,
          sumIf(toFloat(properties.cache_read_tokens), event='llm:request_completed') AS cache_read_tokens,
          if(input_tokens + cache_read_tokens = 0, 0, cache_read_tokens / (input_tokens + cache_read_tokens)) AS cache_hit_ratio,
          quantileIf(0.5)(toFloat(properties.ttfb_ms), event='llm:request_completed') AS llm_ttfb_p50_ms,
          quantileIf(0.95)(toFloat(properties.ttfb_ms), event='llm:request_completed') AS llm_ttfb_p95_ms,
          quantileIf(0.5)(toFloat(properties.duration_ms), event='llm:request_completed') AS llm_p50_ms,
          quantileIf(0.95)(toFloat(properties.duration_ms), event='llm:request_completed') AS llm_p95_ms,
          quantileIf(0.5)(toFloat(properties.ttfb_ms), event='llm:request_completed' AND toInt(properties.message_count) = 1) AS first_message_ttfb_p50_ms,
          quantileIf(0.95)(toFloat(properties.ttfb_ms), event='llm:request_completed' AND toInt(properties.message_count) = 1) AS first_message_ttfb_p95_ms,
          quantileIf(0.5)(toFloat(properties.duration_ms), event='llm:request_completed' AND toInt(properties.message_count) = 1) AS first_message_llm_p50_ms,
          quantileIf(0.95)(toFloat(properties.duration_ms), event='llm:request_completed' AND toInt(properties.message_count) = 1) AS first_message_llm_p95_ms
        FROM events
        WHERE timestamp >= toDateTime('{START_UTC:%Y-%m-%d %H:%M:%S}')
          AND timestamp < toDateTime('{END_UTC:%Y-%m-%d %H:%M:%S}')
          AND event IN (
            'chat:session_start','chat:message_sent','chat:response_received',
            'chat:response_aborted','chat.stream.errored','chat.stream.aborted',
            'error:message_failed','llm:request_completed'
          )
          AND person_id IS NOT NULL
        GROUP BY date
        ORDER BY date
        """
    )
    return write_csv(
        f"posthog_agent_quality_more_{START}_{END_EXCLUSIVE}.csv",
        [
            "date",
            "chat_sessions",
            "chat_session_users",
            "messages",
            "message_users",
            "responses",
            "response_per_message",
            "stream_errors",
            "message_failed",
            "message_failed_per_message",
            "llm_total",
            "llm_2xx",
            "llm_4xx_5xx",
            "llm_2xx_rate",
            "llm_users",
            "requests_with_tools_available",
            "requests_with_tool_use",
            "tool_use_request_rate",
            "tool_use_count",
            "requests_with_tool_result_context",
            "tool_result_context_count",
            "credits",
            "credits_per_message_user",
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_hit_ratio",
            "llm_ttfb_p50_ms",
            "llm_ttfb_p95_ms",
            "llm_p50_ms",
            "llm_p95_ms",
            "first_message_ttfb_p50_ms",
            "first_message_ttfb_p95_ms",
            "first_message_llm_p50_ms",
            "first_message_llm_p95_ms",
        ],
        rows,
    )


def pull_retention_activity() -> Path:
    history_start_utc = START_UTC - dt.timedelta(days=29)
    rows = hogql(
        f"""
        SELECT
          toDate(toTimeZone(timestamp, '{TZ}')) AS date,
          person_id,
          count() AS messages
        FROM events
        WHERE timestamp >= toDateTime('{history_start_utc:%Y-%m-%d %H:%M:%S}')
          AND timestamp < toDateTime('{END_UTC:%Y-%m-%d %H:%M:%S}')
          AND event = 'chat:message_sent'
          AND person_id IS NOT NULL
        GROUP BY date, person_id
        ORDER BY date
        LIMIT 10000000
        """
    )
    first_seen_rows = hogql(
        f"""
        SELECT
          person_id,
          min(toDate(toTimeZone(timestamp, '{TZ}'))) AS first_message_date
        FROM events
        WHERE timestamp < toDateTime('{END_UTC:%Y-%m-%d %H:%M:%S}')
          AND event = 'chat:message_sent'
          AND person_id IS NOT NULL
        GROUP BY person_id
        LIMIT 10000000
        """
    )
    first_seen_day = {str(person_id): str(first_message_date)[:10] for person_id, first_message_date in first_seen_rows}
    people_by_day: dict[str, set[str]] = defaultdict(set)
    messages_by_day: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for date_value, person_id, messages in rows:
        day = str(date_value)[:10]
        person = str(person_id)
        people_by_day[day].add(person)
        messages_by_day[day][person] += int(messages or 0)

    output_rows: list[list[Any]] = []
    for day_str in DAYS:
        day = dt.date.fromisoformat(day_str)
        dau = people_by_day.get(day_str, set())
        wau: set[str] = set()
        mau: set[str] = set()
        for offset in range(7):
            wau |= people_by_day.get((day - dt.timedelta(days=offset)).isoformat(), set())
        for offset in range(30):
            mau |= people_by_day.get((day - dt.timedelta(days=offset)).isoformat(), set())
        messages_7d: dict[str, int] = defaultdict(int)
        messages_8_30d: dict[str, int] = defaultdict(int)
        for offset in range(7):
            bucket = messages_by_day.get((day - dt.timedelta(days=offset)).isoformat(), {})
            for person, count in bucket.items():
                messages_7d[person] += count
        for offset in range(7, 30):
            bucket = messages_by_day.get((day - dt.timedelta(days=offset)).isoformat(), {})
            for person, count in bucket.items():
                messages_8_30d[person] += count
        freq_heavy = freq_medium = freq_light = freq_low = freq_cooling = 0
        for person in mau:
            recent_messages = messages_7d.get(person, 0)
            if recent_messages >= 10:
                freq_heavy += 1
            elif 5 <= recent_messages <= 9:
                freq_medium += 1
            elif 2 <= recent_messages <= 4:
                freq_light += 1
            elif recent_messages == 1:
                freq_low += 1
            elif messages_8_30d.get(person, 0) > 0:
                freq_cooling += 1
        new_dau = {person for person in dau if first_seen_day.get(person) == day_str}
        new_wau = {
            person
            for person in wau
            if first_seen_day.get(person)
            and day - dt.timedelta(days=6) <= dt.date.fromisoformat(first_seen_day[person]) <= day
        }
        new_mau = {
            person
            for person in mau
            if first_seen_day.get(person)
            and day - dt.timedelta(days=29) <= dt.date.fromisoformat(first_seen_day[person]) <= day
        }
        output_rows.append(
            [
                day_str,
                len(dau),
                len(new_dau),
                len(dau - new_dau),
                len(wau),
                len(new_wau),
                len(wau - new_wau),
                len(mau),
                len(new_mau),
                len(mau - new_mau),
                freq_heavy,
                freq_medium,
                freq_light,
                freq_low,
                freq_cooling,
            ]
        )
    return write_csv(
        f"posthog_retention_activity_{START}_{END_EXCLUSIVE}.csv",
        [
            "date",
            "dau",
            "new_dau",
            "returning_dau",
            "wau",
            "new_wau",
            "returning_wau",
            "mau",
            "new_mau",
            "returning_mau",
            "mau_freq_heavy_daily",
            "mau_freq_medium",
            "mau_freq_light",
            "mau_freq_low",
            "mau_freq_cooling",
        ],
        output_rows,
    )


SUBSCRIPTION_SEGMENTS = [
    ("unsubscribed", "未订阅"),
    ("freetrial", "freetrial"),
    ("paid", "付费"),
    ("past_due", "扣款失败"),
    ("canceled_subscription", "取消订阅"),
]


def _customer_email(customer: Any) -> str:
    if isinstance(customer, dict):
        return str(customer.get("email") or "").strip().lower()
    return ""


def _subscription_status_on_day(subscriptions: list[dict[str, Any]], day_end_epoch: int) -> str:
    has_canceled = False
    has_freetrial = False
    has_paid = False
    has_past_due = False
    for sub in subscriptions:
        created = int(sub.get("created") or 0)
        if created >= day_end_epoch:
            continue
        ended = sub.get("ended_at") or sub.get("canceled_at")
        ended_int = int(ended or 0)
        if ended_int and ended_int < day_end_epoch:
            has_canceled = True
            continue
        status = str(sub.get("status") or "")
        if status in {"past_due", "unpaid"}:
            has_past_due = True
        elif status == "active":
            has_paid = True
        elif status == "trialing":
            has_freetrial = True
        elif status in {"canceled", "incomplete_expired"}:
            has_canceled = True
    if has_past_due:
        return "past_due"
    if has_paid:
        return "paid"
    if has_freetrial:
        return "freetrial"
    if has_canceled:
        return "canceled_subscription"
    return "unsubscribed"


def pull_retention_subscription_segments() -> Path:
    history_start_utc = START_UTC - dt.timedelta(days=29)
    person_rows = hogql(
        f"""
        SELECT
          person_id,
          lower(trim(toString(any(person.properties.email)))) AS email,
          min(toDate(toTimeZone(timestamp, '{TZ}'))) AS first_message_date
        FROM events
        WHERE timestamp < toDateTime('{END_UTC:%Y-%m-%d %H:%M:%S}')
          AND event = 'chat:message_sent'
          AND person_id IS NOT NULL
        GROUP BY person_id
        LIMIT 10000000
        """
    )
    person_email: dict[str, str] = {}
    first_seen_day: dict[str, str] = {}
    for person_id, email, first_message_date in person_rows:
        person = str(person_id)
        person_email[person] = str(email or "").strip().lower()
        first_seen_day[person] = str(first_message_date)[:10]

    message_rows = hogql(
        f"""
        SELECT
          toDate(toTimeZone(timestamp, '{TZ}')) AS date,
          person_id,
          count() AS messages
        FROM events
        WHERE timestamp >= toDateTime('{history_start_utc:%Y-%m-%d %H:%M:%S}')
          AND timestamp < toDateTime('{END_UTC:%Y-%m-%d %H:%M:%S}')
          AND event = 'chat:message_sent'
          AND person_id IS NOT NULL
        GROUP BY date, person_id
        ORDER BY date
        LIMIT 10000000
        """
    )
    people_by_day: dict[str, set[str]] = defaultdict(set)
    for date_value, person_id, _messages in message_rows:
        people_by_day[str(date_value)[:10]].add(str(person_id))

    end_epoch = int(END_UTC.replace(tzinfo=dt.timezone.utc).timestamp())
    subscriptions = stripe_list(
        "subscriptions",
        {"status": "all", "created[lt]": end_epoch, "expand[]": "data.customer"},
    )
    subscriptions_by_email: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for sub in subscriptions:
        email = _customer_email(sub.get("customer"))
        if email:
            subscriptions_by_email[email].append(sub)

    header = ["date"]
    for key, _label in SUBSCRIPTION_SEGMENTS:
        header.extend(
            [
                f"{key}_users",
                f"{key}_dau",
                f"{key}_mau",
                f"{key}_inactive_7d",
                f"{key}_d1_cohort",
                f"{key}_d1_retained",
                f"{key}_return_users",
                f"{key}_return_7d_active",
            ]
        )

    output_rows: list[list[Any]] = []
    for day_str in DAYS:
        day = dt.date.fromisoformat(day_str)
        day_end_epoch = epoch_from_bjt(day + dt.timedelta(days=1))
        history_people = {
            person
            for person, first_day in first_seen_day.items()
            if first_day <= day_str
        }
        dau = people_by_day.get(day_str, set())
        mau: set[str] = set()
        active_7d: set[str] = set()
        for offset in range(30):
            bucket = people_by_day.get((day - dt.timedelta(days=offset)).isoformat(), set())
            mau |= bucket
            if offset < 7:
                active_7d |= bucket
        d1_people = people_by_day.get((day + dt.timedelta(days=1)).isoformat(), set())
        cohort = {person for person, first_day in first_seen_day.items() if first_day == day_str}
        previous_7d: set[str] = set()
        earlier_active: set[str] = set()
        next_7d: set[str] = set()
        for offset in range(1, 8):
            previous_7d |= people_by_day.get((day - dt.timedelta(days=offset)).isoformat(), set())
            next_7d |= people_by_day.get((day + dt.timedelta(days=offset)).isoformat(), set())
        for offset in range(8, 30):
            earlier_active |= people_by_day.get((day - dt.timedelta(days=offset)).isoformat(), set())
        return_users = dau & earlier_active - previous_7d

        people_by_segment: dict[str, set[str]] = {key: set() for key, _label in SUBSCRIPTION_SEGMENTS}
        for person in history_people:
            email = person_email.get(person, "")
            status = _subscription_status_on_day(subscriptions_by_email.get(email, []), day_end_epoch) if email else "unsubscribed"
            people_by_segment[status].add(person)

        row: list[Any] = [day_str]
        for key, _label in SUBSCRIPTION_SEGMENTS:
            segment_people = people_by_segment[key]
            segment_cohort = cohort & segment_people
            d1_cohort = len(segment_cohort)
            if day + dt.timedelta(days=1) >= END_EXCLUSIVE:
                d1_retained = ""
            else:
                d1_retained = len(segment_cohort & d1_people)
            segment_return = return_users & segment_people
            if day + dt.timedelta(days=7) >= END_EXCLUSIVE:
                return_7d_active = ""
            else:
                return_7d_active = len(segment_return & next_7d)
            row.extend(
                [
                    len(segment_people),
                    len(segment_people & dau),
                    len(segment_people & mau),
                    len(segment_people - active_7d),
                    d1_cohort,
                    d1_retained,
                    len(segment_return),
                    return_7d_active,
                ]
            )
        output_rows.append(row)

    return write_csv(
        f"posthog_retention_subscription_segments_{START}_{END_EXCLUSIVE}.csv",
        header,
        output_rows,
    )


def pull_engineering() -> Path:
    rows = hogql(
        f"""
        SELECT
          toDate(toTimeZone(timestamp, '{TZ}')) AS date,
          countIf(event='server:api_called') AS api_calls,
          countIf(event='server:api_called' AND toInt(properties.status_code) >= 200 AND toInt(properties.status_code) < 400) AS api_success,
          countIf(event='server:api_called' AND toInt(properties.status_code) >= 400) AS api_fail,
          if(api_calls = 0, 0, api_success / api_calls) AS api_success_rate,
          quantileIf(0.5)(toFloat(properties.latency_ms), event='server:api_called') AS api_p50_ms,
          quantileIf(0.95)(toFloat(properties.latency_ms), event='server:api_called') AS api_p95_ms,
          quantileIf(0.99)(toFloat(properties.latency_ms), event='server:api_called') AS api_p99_ms,
          countIf(event='error:ws_error') AS ws_error,
          count(DISTINCT if(event='error:ws_error', person_id, NULL)) AS ws_error_users,
          countIf(event='error:message_failed') AS message_failed,
          countIf(event='error:env_init_failed') AS env_init_failed,
          countIf(event='sandbox:restart_failed') AS sandbox_restart_failed,
          countIf(event IN ('chat:response_aborted','chat.stream.errored','chat.stream.aborted')) AS chat_stream_errored,
          countIf(event='file:upload_failed') AS file_upload_failed,
          countIf(event='payment:checkout_start_failed') AS checkout_start_failed,
          countIf(event='payment:checkout_verify_failed') AS checkout_verify_failed,
          countIf(event='payment:checkout_fulfillment_failed') AS checkout_fulfillment_failed,
          0 AS exceptions,
          countIf(event='perf:page_loaded' AND toString(properties.page) = '/chat') AS page_loads,
          quantileIf(0.5)(toFloat(properties.load_time_ms), event='perf:page_loaded' AND toString(properties.page) = '/chat') AS page_load_p50_ms,
          quantileIf(0.95)(toFloat(properties.load_time_ms), event='perf:page_loaded' AND toString(properties.page) = '/chat') AS page_load_p95_ms,
          countIf(event='perf:env_init') AS env_init_count,
          quantileIf(0.5)(toFloat(properties.duration_ms), event='perf:env_init') AS env_init_p50_ms,
          quantileIf(0.95)(toFloat(properties.duration_ms), event='perf:env_init') AS env_init_p95_ms
        FROM events
        WHERE timestamp >= toDateTime('{START_UTC:%Y-%m-%d %H:%M:%S}')
          AND timestamp < toDateTime('{END_UTC:%Y-%m-%d %H:%M:%S}')
          AND event IN (
            'server:api_called','error:ws_error','error:message_failed',
            'error:env_init_failed','sandbox:restart_failed',
            'chat:response_aborted','chat.stream.errored','chat.stream.aborted',
            'file:upload_failed','payment:checkout_start_failed',
            'payment:checkout_verify_failed','payment:checkout_fulfillment_failed',
            'perf:page_loaded','perf:env_init'
          )
        GROUP BY date
        ORDER BY date
        """
    )
    first_env_rows = hogql(
        f"""
        SELECT
          date,
          quantile(0.5)(first_duration_ms) AS env_init_first_daily_p50_ms,
          quantile(0.95)(first_duration_ms) AS env_init_first_daily_p95_ms
        FROM (
          SELECT
            toDate(toTimeZone(timestamp, '{TZ}')) AS date,
            person_id,
            argMin(toFloat(properties.duration_ms), timestamp) AS first_duration_ms
          FROM events
          WHERE timestamp >= toDateTime('{START_UTC:%Y-%m-%d %H:%M:%S}')
            AND timestamp < toDateTime('{END_UTC:%Y-%m-%d %H:%M:%S}')
            AND event = 'perf:env_init'
            AND person_id IS NOT NULL
          GROUP BY date, person_id
        )
        GROUP BY date
        ORDER BY date
        """
    )
    first_env_by_day = {str(row[0])[:10]: row[1:] for row in first_env_rows}
    rows = [list(row) + list(first_env_by_day.get(str(row[0])[:10], ["", ""])) for row in rows]
    return write_csv(
        f"posthog_engineering_quality_more_{START}_{END_EXCLUSIVE}.csv",
        [
            "date",
            "api_calls",
            "api_success",
            "api_fail",
            "api_success_rate",
            "api_p50_ms",
            "api_p95_ms",
            "api_p99_ms",
            "ws_error",
            "ws_error_users",
            "message_failed",
            "env_init_failed",
            "sandbox_restart_failed",
            "chat_stream_errored",
            "file_upload_failed",
            "checkout_start_failed",
            "checkout_verify_failed",
            "checkout_fulfillment_failed",
            "exceptions",
            "page_loads",
            "page_load_p50_ms",
            "page_load_p95_ms",
            "env_init_count",
            "env_init_p50_ms",
            "env_init_p95_ms",
            "env_init_first_daily_p50_ms",
            "env_init_first_daily_p95_ms",
        ],
        rows,
    )


def pull_file_usage() -> Path:
    rows = hogql(
        f"""
        SELECT
          toDate(toTimeZone(timestamp, '{TZ}')) AS date,
          countIf(event='file:upload_started') AS upload_started,
          count(DISTINCT if(event='file:upload_started', person_id, NULL)) AS upload_started_users,
          countIf(event='file:upload_completed') AS upload_completed,
          count(DISTINCT if(event='file:upload_completed', person_id, NULL)) AS upload_completed_users,
          countIf(event='file:upload_failed') AS upload_failed,
          count(DISTINCT if(event='file:upload_failed', person_id, NULL)) AS upload_failed_users,
          countIf(event='file:upload_cancelled') AS upload_cancelled,
          if(upload_started = 0, 0, upload_completed / upload_started) AS upload_success_rate,
          if(upload_started = 0, 0, upload_failed / upload_started) AS upload_failed_rate,
          countIf(event='file:attach_processed') AS attach_processed,
          countIf(event='file:viewed') AS file_viewed,
          countIf(event='file:paste') AS file_paste,
          quantileIf(0.5)(toFloat(properties.file_size_bytes), event='file:upload_completed') AS uploaded_size_p50_bytes,
          quantileIf(0.95)(toFloat(properties.file_size_bytes), event='file:upload_completed') AS uploaded_size_p95_bytes
        FROM events
        WHERE timestamp >= toDateTime('{START_UTC:%Y-%m-%d %H:%M:%S}')
          AND timestamp < toDateTime('{END_UTC:%Y-%m-%d %H:%M:%S}')
          AND event IN ('file:upload_started','file:upload_completed','file:upload_failed','file:upload_cancelled','file:attach_processed','file:viewed','file:paste')
          AND person_id IS NOT NULL
        GROUP BY date
        ORDER BY date
        """
    )
    return write_csv(
        f"posthog_file_usage_{START}_{END_EXCLUSIVE}.csv",
        [
            "date",
            "upload_started",
            "upload_started_users",
            "upload_completed",
            "upload_completed_users",
            "upload_failed",
            "upload_failed_users",
            "upload_cancelled",
            "upload_success_rate",
            "upload_failed_rate",
            "attach_processed",
            "file_viewed",
            "file_paste",
            "uploaded_size_p50_bytes",
            "uploaded_size_p95_bytes",
        ],
        rows,
    )


def pull_finance_funnel() -> tuple[Path, Path]:
    funnel_rows = hogql(
        f"""
        SELECT
          toDate(toTimeZone(timestamp, '{TZ}')) AS date,
          countIf(event='payment:pricing_opened') AS pricing_opened,
          count(DISTINCT if(event='payment:pricing_opened', person_id, NULL)) AS pricing_opened_users,
          countIf(event='payment:checkout_started') AS checkout_started,
          count(DISTINCT if(event='payment:checkout_started', person_id, NULL)) AS checkout_started_users,
          countIf(event='payment:checkout_session_created') AS checkout_session_created,
          count(DISTINCT if(event='payment:checkout_session_created', person_id, NULL)) AS checkout_session_created_users,
          countIf(event='payment:checkout_returned') AS checkout_returned,
          count(DISTINCT if(event='payment:checkout_returned', person_id, NULL)) AS checkout_returned_users,
          countIf(event='payment:checkout_verified') AS checkout_verified,
          count(DISTINCT if(event='payment:checkout_verified', person_id, NULL)) AS checkout_verified_users,
          countIf(event='payment:checkout_fulfilled') AS checkout_fulfilled,
          count(DISTINCT if(event='payment:checkout_fulfilled', person_id, NULL)) AS checkout_fulfilled_users,
          countIf(event='payment:checkout_fulfilled' AND properties.order_type='subscription') AS fulfilled_subscription,
          countIf(event='payment:checkout_fulfilled' AND properties.order_type='credit_pack') AS fulfilled_credit_pack,
          sumIf(toFloat(properties.amount_cents) / 100.0, event='payment:checkout_fulfilled') AS fulfilled_amount_usd_event,
          if(pricing_opened_users = 0, 0, checkout_started_users / pricing_opened_users) AS pricing_to_started_same_day_user_ratio,
          if(checkout_started_users = 0, 0, checkout_session_created_users / checkout_started_users) AS started_to_session_created_same_day_user_ratio,
          if(checkout_session_created_users = 0, 0, checkout_verified_users / checkout_session_created_users) AS session_created_to_verified_same_day_user_ratio,
          if(checkout_verified_users = 0, 0, checkout_fulfilled_users / checkout_verified_users) AS verified_to_fulfilled_same_day_user_ratio,
          countIf(event='payment:checkout_start_failed') AS checkout_start_failed,
          countIf(event='payment:checkout_verify_failed') AS checkout_verify_failed,
          countIf(event='payment:checkout_fulfillment_failed') AS checkout_fulfillment_failed
        FROM events
        WHERE timestamp >= toDateTime('{START_UTC:%Y-%m-%d %H:%M:%S}')
          AND timestamp < toDateTime('{END_UTC:%Y-%m-%d %H:%M:%S}')
          AND event IN (
            'payment:pricing_opened','payment:checkout_started',
            'payment:checkout_session_created','payment:checkout_returned',
            'payment:checkout_verified','payment:checkout_fulfilled',
            'payment:checkout_start_failed','payment:checkout_verify_failed',
            'payment:checkout_fulfillment_failed'
          )
          AND person_id IS NOT NULL
        GROUP BY date
        ORDER BY date
        """
    )
    funnel_path = write_csv(
        f"posthog_finance_checkout_funnel_{START}_{END_EXCLUSIVE}.csv",
        [
            "date",
            "pricing_opened",
            "pricing_opened_users",
            "checkout_started",
            "checkout_started_users",
            "checkout_session_created",
            "checkout_session_created_users",
            "checkout_returned",
            "checkout_returned_users",
            "checkout_verified",
            "checkout_verified_users",
            "checkout_fulfilled",
            "checkout_fulfilled_users",
            "fulfilled_subscription",
            "fulfilled_credit_pack",
            "fulfilled_amount_usd_event",
            "pricing_to_started_same_day_user_ratio",
            "started_to_session_created_same_day_user_ratio",
            "session_created_to_verified_same_day_user_ratio",
            "verified_to_fulfilled_same_day_user_ratio",
            "checkout_start_failed",
            "checkout_verify_failed",
            "checkout_fulfillment_failed",
        ],
        funnel_rows,
    )

    flow_rows = hogql(
        f"""
        WITH flow_events AS (
          SELECT
            toString(properties.checkout_flow_id) AS flow_id,
            toDate(toTimeZone(timestamp, '{TZ}')) AS event_day,
            event,
            properties.order_type AS order_type,
            toFloat(properties.amount_cents) / 100.0 AS amount_usd
          FROM events
          WHERE timestamp >= toDateTime('{START_UTC:%Y-%m-%d %H:%M:%S}')
            AND timestamp < toDateTime('{END_UTC:%Y-%m-%d %H:%M:%S}')
            AND event IN (
              'payment:checkout_started','payment:checkout_session_created',
              'payment:checkout_returned','payment:checkout_verified',
              'payment:checkout_fulfilled','payment:checkout_start_failed',
              'payment:checkout_verify_failed','payment:checkout_fulfillment_failed'
            )
            AND properties.checkout_flow_id IS NOT NULL
        ),
        flow_first AS (
          SELECT flow_id, min(event_day) AS date
          FROM flow_events
          GROUP BY flow_id
        )
        SELECT
          f.date AS date,
          count(DISTINCT f.flow_id) AS checkout_flows_first_seen,
          count(DISTINCT if(e.event='payment:checkout_started', f.flow_id, NULL)) AS has_started,
          count(DISTINCT if(e.event='payment:checkout_session_created', f.flow_id, NULL)) AS has_session_created,
          count(DISTINCT if(e.event='payment:checkout_returned', f.flow_id, NULL)) AS has_returned,
          count(DISTINCT if(e.event='payment:checkout_verified', f.flow_id, NULL)) AS has_verified,
          count(DISTINCT if(e.event='payment:checkout_fulfilled', f.flow_id, NULL)) AS has_fulfilled,
          if(has_session_created = 0, 0, has_verified / has_session_created) AS session_created_to_verified_flow_rate,
          if(has_session_created = 0, 0, has_fulfilled / has_session_created) AS session_created_to_fulfilled_flow_rate,
          count(DISTINCT if(e.event='payment:checkout_start_failed', f.flow_id, NULL)) AS has_start_failed,
          count(DISTINCT if(e.event='payment:checkout_verify_failed', f.flow_id, NULL)) AS has_verify_failed,
          count(DISTINCT if(e.event='payment:checkout_fulfillment_failed', f.flow_id, NULL)) AS has_fulfillment_failed,
          count(DISTINCT if(e.order_type='subscription', f.flow_id, NULL)) AS subscription_flows,
          count(DISTINCT if(e.order_type='credit_pack', f.flow_id, NULL)) AS credit_pack_flows,
          count(DISTINCT if(e.order_type IS NULL OR e.order_type='', f.flow_id, NULL)) AS unknown_order_type_flows,
          sumIf(e.amount_usd, e.event='payment:checkout_fulfilled') AS amount_usd_event
        FROM flow_first f
        LEFT JOIN flow_events e ON e.flow_id = f.flow_id
        WHERE f.date >= toDate('{START.isoformat()}')
          AND f.date < toDate('{END_EXCLUSIVE.isoformat()}')
        GROUP BY f.date
        ORDER BY f.date
        """
    )
    flow_path = write_csv(
        f"posthog_finance_checkout_flow_cohort_{START}_{END_EXCLUSIVE}.csv",
        [
            "date",
            "checkout_flows_first_seen",
            "has_started",
            "has_session_created",
            "has_returned",
            "has_verified",
            "has_fulfilled",
            "session_created_to_verified_flow_rate",
            "session_created_to_fulfilled_flow_rate",
            "has_start_failed",
            "has_verify_failed",
            "has_fulfillment_failed",
            "subscription_flows",
            "credit_pack_flows",
            "unknown_order_type_flows",
            "amount_usd_event",
        ],
        flow_rows,
    )
    return funnel_path, flow_path


def pull_new_uv_cohort() -> Path:
    rows = hogql(
        f"""
        WITH first_pageview AS (
          SELECT person_id, min(toDate(toTimeZone(timestamp, '{TZ}'))) AS first_pageview_day
          FROM events
          WHERE event='$pageview'
            AND timestamp < toDateTime('{END_UTC:%Y-%m-%d %H:%M:%S}')
            AND properties.$host='moclaw.ai'
            AND person_id IS NOT NULL
          GROUP BY person_id
        ),
        daily AS (
          SELECT
            toDate(toTimeZone(timestamp, '{TZ}')) AS day,
            person_id,
            countIf(event='$pageview') AS pageviews,
            countIf(event='chat:session_start') AS chat_sessions,
            countIf(event='auth:login_completed') AS login_completed,
            countIf(event='payment:checkout_started') AS checkout_started,
            countIf(event='payment:checkout_fulfilled' AND properties.order_type='subscription') AS freetrial_created,
            countIf(event='chat:message_sent') AS messages,
            countIf(event='command:selected') AS commands,
            countIf(event='chat:response_received') AS responses
          FROM events
          WHERE timestamp >= toDateTime('{START_UTC:%Y-%m-%d %H:%M:%S}')
            AND timestamp < toDateTime('{END_UTC:%Y-%m-%d %H:%M:%S}')
            AND event IN (
              '$pageview','chat:session_start',
              'auth:login_completed','payment:checkout_started','payment:checkout_fulfilled',
              'chat:message_sent','command:selected','chat:response_received'
            )
            AND person_id IS NOT NULL
          GROUP BY day, person_id
        ),
        cohort AS (
          SELECT person_id, first_pageview_day AS day
          FROM first_pageview
          WHERE first_pageview_day >= toDate('{START.isoformat()}')
            AND first_pageview_day < toDate('{END_EXCLUSIVE.isoformat()}')
        )
        SELECT
          c.day AS date,
          count(DISTINCT c.person_id) AS new_uv,
          count(DISTINCT if(d0.login_completed > 0, c.person_id, NULL)) AS registered_d0_users,
          count(DISTINCT if(d0.login_completed > 0 AND d0.checkout_started > 0, c.person_id, NULL)) AS checkout_started_d0_users,
          count(DISTINCT if(d0.login_completed > 0 AND d0.freetrial_created > 0, c.person_id, NULL)) AS freetrial_d0_users,
          count(DISTINCT if(d0.login_completed > 0 AND d0.freetrial_created > 0 AND d0.messages > 0, c.person_id, NULL)) AS freetrial_message_d0_users,
          count(DISTINCT if(d0.messages > 0, c.person_id, NULL)) AS first_message_d0_users,
          count(DISTINCT if(d0.commands > 0, c.person_id, NULL)) AS first_task_start_d0_users,
          count(DISTINCT if(d0.commands > 0 AND d0.responses > 0, c.person_id, NULL)) AS first_task_done_d0_users,
          sum(coalesce(d0.messages, 0)) AS d0_messages,
          if(
            addDays(c.day, 2) <= toDate('{LAST_COMPLETE_BJT_DAY.isoformat()}'),
            sum(coalesce(d0.messages, 0) + coalesce(d1.messages, 0) + coalesce(d2.messages, 0)),
            NULL
          ) AS d0_d2_messages,
          if(
            addDays(c.day, 1) <= toDate('{LAST_COMPLETE_BJT_DAY.isoformat()}'),
            count(DISTINCT if(
              d0.messages > 0 AND (
                d1.pageviews > 0 OR d1.chat_sessions > 0 OR d1.messages > 0 OR d1.commands > 0 OR d1.responses > 0
              ),
              c.person_id,
              NULL
            )),
            NULL
          ) AS next_return_d1_users,
          if(
            addDays(c.day, 1) <= toDate('{LAST_COMPLETE_BJT_DAY.isoformat()}'),
            count(DISTINCT if(d0.messages > 0 AND (d1.chat_sessions > 0 OR d1.messages > 0), c.person_id, NULL)),
            NULL
          ) AS next_chat_d1_users,
          if(
            addDays(c.day, 1) <= toDate('{LAST_COMPLETE_BJT_DAY.isoformat()}'),
            count(DISTINCT if(d0.messages > 0 AND d1.commands > 0, c.person_id, NULL)),
            NULL
          ) AS next_task_start_d1_users,
          if(
            addDays(c.day, 1) <= toDate('{LAST_COMPLETE_BJT_DAY.isoformat()}'),
            count(DISTINCT if(d0.messages > 0 AND d1.commands > 0 AND d1.responses > 0, c.person_id, NULL)),
            NULL
          ) AS next_task_done_d1_users
        FROM cohort c
        LEFT JOIN daily d0 ON d0.person_id = c.person_id AND d0.day = c.day
        LEFT JOIN daily d1 ON d1.person_id = c.person_id AND d1.day = addDays(c.day, 1)
        LEFT JOIN daily d2 ON d2.person_id = c.person_id AND d2.day = addDays(c.day, 2)
        GROUP BY c.day
        ORDER BY c.day
        """
    )
    return write_csv(
        f"posthog_new_uv_cohort_{START}_{END_EXCLUSIVE}.csv",
        [
            "date",
            "new_uv",
            "registered_d0_users",
            "checkout_started_d0_users",
            "freetrial_d0_users",
            "freetrial_message_d0_users",
            "first_message_d0_users",
            "first_task_start_d0_users",
            "first_task_done_d0_users",
            "d0_messages",
            "d0_d2_messages",
            "next_return_d1_users",
            "next_chat_d1_users",
            "next_task_start_d1_users",
            "next_task_done_d1_users",
        ],
        rows,
    )


def pull_new_uv_channel_cohort() -> Path:
    rows = hogql(
        f"""
        WITH first_pageview AS (
          SELECT
            person_id,
            min(toDate(toTimeZone(timestamp, '{TZ}'))) AS first_pageview_day,
            argMin({CHANNEL_CASE}, timestamp) AS channel
          FROM events
          WHERE event='$pageview'
            AND timestamp < toDateTime('{END_UTC:%Y-%m-%d %H:%M:%S}')
            AND properties.$host='moclaw.ai'
            AND person_id IS NOT NULL
          GROUP BY person_id
        ),
        daily AS (
          SELECT
            toDate(toTimeZone(timestamp, '{TZ}')) AS day,
            person_id,
            countIf(event='auth:login_completed') AS login_completed,
            countIf(event='payment:checkout_fulfilled' AND properties.order_type='subscription') AS freetrial_created,
            countIf(event='chat:message_sent') AS messages
          FROM events
          WHERE timestamp >= toDateTime('{START_UTC:%Y-%m-%d %H:%M:%S}')
            AND timestamp < toDateTime('{END_UTC:%Y-%m-%d %H:%M:%S}')
            AND event IN ('auth:login_completed','payment:checkout_fulfilled','chat:message_sent')
            AND person_id IS NOT NULL
          GROUP BY day, person_id
        ),
        cohort AS (
          SELECT person_id, first_pageview_day AS day, channel
          FROM first_pageview
          WHERE first_pageview_day >= toDate('{START.isoformat()}')
            AND first_pageview_day < toDate('{END_EXCLUSIVE.isoformat()}')
        )
        SELECT
          c.day AS date,
          c.channel AS channel,
          count(DISTINCT c.person_id) AS new_uv,
          count(DISTINCT if(d0.login_completed > 0, c.person_id, NULL)) AS registered_d0_users,
          count(DISTINCT if(d0.login_completed > 0 AND d0.freetrial_created > 0, c.person_id, NULL)) AS freetrial_d0_users,
          count(DISTINCT if(d0.login_completed > 0 AND d0.freetrial_created > 0 AND d0.messages > 0, c.person_id, NULL)) AS freetrial_message_d0_users,
          count(DISTINCT if(d0.messages > 0, c.person_id, NULL)) AS first_message_d0_users
        FROM cohort c
        LEFT JOIN daily d0 ON d0.person_id = c.person_id AND d0.day = c.day
        GROUP BY c.day, c.channel
        ORDER BY c.day, c.channel
        """
    )
    by_key = {(str(row[0])[:10], row[1]): row for row in rows}
    full_rows = []
    for day in DAYS:
        for channel in NEW_UV_CHANNELS:
            row = by_key.get((day, channel))
            full_rows.append(row if row else [day, channel, 0, 0, 0, 0, 0])
    return write_raw_csv(
        f"posthog_new_uv_channel_cohort_{START}_{END_EXCLUSIVE}.csv",
        [
            "date",
            "channel",
            "new_uv",
            "registered_d0_users",
            "freetrial_d0_users",
            "freetrial_message_d0_users",
            "first_message_d0_users",
        ],
        full_rows,
    )


def pull_registration_cohort() -> Path:
    rows = hogql(
        f"""
        WITH first_login AS (
          SELECT person_id, min(toDate(toTimeZone(timestamp, '{TZ}'))) AS first_login_day
          FROM events
          WHERE event='auth:login_completed'
            AND timestamp < toDateTime('{END_UTC:%Y-%m-%d %H:%M:%S}')
            AND person_id IS NOT NULL
          GROUP BY person_id
        ),
        daily AS (
          SELECT
            toDate(toTimeZone(timestamp, '{TZ}')) AS day,
            person_id,
            countIf(event='payment:checkout_started') AS checkout_started,
            countIf(event='payment:checkout_fulfilled' AND properties.order_type='subscription') AS freetrial_created,
            countIf(event='payment:checkout_start_failed') AS checkout_start_failed,
            countIf(event='payment:checkout_verify_failed') AS checkout_verify_failed,
            countIf(event='payment:checkout_fulfillment_failed') AS checkout_fulfillment_failed
          FROM events
          WHERE timestamp >= toDateTime('{START_UTC:%Y-%m-%d %H:%M:%S}')
            AND timestamp < toDateTime('{END_UTC:%Y-%m-%d %H:%M:%S}')
            AND event IN (
              'payment:checkout_started','payment:checkout_fulfilled',
              'payment:checkout_start_failed','payment:checkout_verify_failed',
              'payment:checkout_fulfillment_failed'
            )
            AND person_id IS NOT NULL
          GROUP BY day, person_id
        ),
        cohort AS (
          SELECT person_id, first_login_day AS day
          FROM first_login
          WHERE first_login_day >= toDate('{START.isoformat()}')
            AND first_login_day < toDate('{END_EXCLUSIVE.isoformat()}')
        )
        SELECT
          c.day AS date,
          count(DISTINCT c.person_id) AS registered_users,
          count(DISTINCT if(d0.checkout_started > 0, c.person_id, NULL)) AS checkout_started_d0_users,
          count(DISTINCT if(d0.freetrial_created > 0, c.person_id, NULL)) AS freetrial_d0_users,
          count(DISTINCT if(d0.checkout_start_failed > 0, c.person_id, NULL)) AS checkout_start_failed_d0_users,
          count(DISTINCT if(d0.checkout_verify_failed > 0, c.person_id, NULL)) AS checkout_verify_failed_d0_users,
          count(DISTINCT if(d0.checkout_fulfillment_failed > 0, c.person_id, NULL)) AS checkout_fulfillment_failed_d0_users
        FROM cohort c
        LEFT JOIN daily d0 ON d0.person_id = c.person_id AND d0.day = c.day
        GROUP BY c.day
        ORDER BY c.day
        """
    )
    return write_csv(
        f"posthog_registration_cohort_{START}_{END_EXCLUSIVE}.csv",
        [
            "date",
            "registered_users",
            "checkout_started_d0_users",
            "freetrial_d0_users",
            "checkout_start_failed_d0_users",
            "checkout_verify_failed_d0_users",
            "checkout_fulfillment_failed_d0_users",
        ],
        rows,
    )


def stripe_get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    response = requests.get(
        f"https://api.stripe.com/v1/{path}",
        auth=(stripe_key(), ""),
        params=params or {},
        timeout=90,
    )
    if response.status_code != 200:
        raise RuntimeError(f"Stripe request failed: {response.status_code} {response.text[:800]}")
    return response.json()


def stripe_list(path: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    output = []
    cursor = None
    while True:
        req = dict(params)
        req["limit"] = 100
        if cursor:
            req["starting_after"] = cursor
        page = stripe_get(path, req)
        data = page.get("data", [])
        output.extend(data)
        if not page.get("has_more") or not data:
            break
        cursor = data[-1]["id"]
    return output


def bjt_day_from_ts(ts: int) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).astimezone(dt.timezone(dt.timedelta(hours=8))).date().isoformat()


def epoch_from_bjt(day: dt.date, hour: int = 0) -> int:
    return int(dt.datetime(day.year, day.month, day.day, hour, tzinfo=dt.timezone(dt.timedelta(hours=8))).timestamp())


def pull_finance_stripe() -> Path:
    end_epoch = int(END_UTC.replace(tzinfo=dt.timezone.utc).timestamp())
    charges = stripe_list("charges", {"created[lt]": end_epoch})
    successful = [charge for charge in charges if charge.get("paid") and charge.get("status") == "succeeded"]

    first_paid_day: dict[str, str] = {}
    cash_gross = defaultdict(float)
    cash_refund = defaultdict(float)
    cash_net = defaultdict(float)
    paid_charge_customers_by_day: dict[str, set[str]] = defaultdict(set)
    for charge in sorted(successful, key=lambda item: item.get("created") or 0):
        customer = charge.get("customer")
        day = bjt_day_from_ts(charge["created"])
        amount = to_number(charge.get("amount")) / 100.0
        refunded = to_number(charge.get("amount_refunded")) / 100.0
        if START.isoformat() <= day < END_EXCLUSIVE.isoformat():
            cash_gross[day] += amount
            cash_refund[day] += refunded
            cash_net[day] += amount - refunded
            if customer:
                paid_charge_customers_by_day[day].add(customer)
        if customer and day <= END_AT_BJT.date().isoformat() and customer not in first_paid_day:
            first_paid_day[customer] = day

    subscriptions = stripe_list(
        "subscriptions",
        {"status": "all", "created[lt]": end_epoch, "expand[]": "data.items.data.price"},
    )

    rows = []
    for day in DAYS:
        day_date = dt.date.fromisoformat(day)
        day_end_epoch = epoch_from_bjt(day_date + dt.timedelta(days=1))
        active_subs = []
        trialing = 0
        past_due = 0
        all_churn = 0
        paid_churn = 0
        for sub in subscriptions:
            created = int(sub.get("created") or 0)
            if created >= day_end_epoch:
                continue
            ended = sub.get("ended_at") or sub.get("canceled_at")
            ended_int = int(ended or 0)
            if ended_int and ended_int < day_end_epoch:
                all_churn += 1
                if sub.get("status") != "trialing":
                    paid_churn += 1
                continue
            status = sub.get("status")
            if status == "active":
                active_subs.append(sub)
            elif status == "trialing":
                trialing += 1
            elif status == "past_due":
                past_due += 1

        mrr = 0.0
        for sub in active_subs:
            for item in sub.get("items", {}).get("data", []):
                price = item.get("price") or {}
                unit_amount = to_number(price.get("unit_amount")) / 100.0
                interval = ((price.get("recurring") or {}).get("interval") or "month")
                quantity = to_number(item.get("quantity") or 1)
                monthly = unit_amount * quantity
                if interval == "year":
                    monthly /= 12.0
                elif interval == "week":
                    monthly *= 52.0 / 12.0
                mrr += monthly

        new_paid_users = sum(1 for first_day in first_paid_day.values() if first_day == day)
        cumulative_paid_users = sum(1 for first_day in first_paid_day.values() if first_day <= day)
        rows.append(
            [
                day,
                round(cash_gross[day], 2),
                round(cash_refund[day], 2),
                round(cash_net[day], 2),
                new_paid_users,
                cumulative_paid_users,
                paid_churn,
                all_churn,
                round(mrr, 2),
                len(active_subs),
                trialing,
                past_due,
                "",
                "",
            ]
        )

    return write_csv(
        f"calc_finance_{START}_{END_EXCLUSIVE}.csv",
        [
            "date",
            "cash_gross",
            "cash_refund",
            "cash_net",
            "new_paid_users",
            "cumulative_paid_users",
            "paid_churn_subs",
            "all_churn_subs",
            "mrr_active",
            "status_active",
            "status_trialing",
            "status_past_due",
            "trial_conversion_rate_existing",
            "paid_uv",
        ],
        rows,
    )


def pull_connectors() -> Path:
    rows = hogql(
        f"""
        SELECT
          toDate(toTimeZone(timestamp, '{TZ}')) AS day,
          event,
          count() AS events,
          count(DISTINCT person_id) AS users
        FROM events
        WHERE timestamp >= toDateTime('{START_UTC:%Y-%m-%d %H:%M:%S}')
          AND timestamp < toDateTime('{END_UTC:%Y-%m-%d %H:%M:%S}')
          AND event IN (
            'connector:telegram_connected','connector:google_connected',
            'connector:slack_connected','connector:discord_connected',
            'connector:lark_connected','connector:google_workspace_folder_set',
            'connector:google_workspace_picker_unavailable'
          )
          AND person_id IS NOT NULL
        GROUP BY day, event
        ORDER BY day, event
        """
    )
    OUT_DIR.mkdir(exist_ok=True)
    path = OUT_DIR / f"posthog_connector_events_{START}_{END_EXCLUSIVE}.csv"
    with path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["day", "event", "events", "users"])
        writer.writerows(rows)
    return path


def pull_web_activation_core() -> Path:
    rows = hogql(
        f"""
        WITH first_pageview AS (
          SELECT person_id, min(toDate(toTimeZone(timestamp, '{TZ}'))) AS first_pageview_day
          FROM events
          WHERE event='$pageview'
            AND timestamp < toDateTime('{END_UTC:%Y-%m-%d %H:%M:%S}')
            AND properties.$host='moclaw.ai'
            AND person_id IS NOT NULL
          GROUP BY person_id
        )
        SELECT
          toDate(toTimeZone(e.timestamp, '{TZ}')) AS date,
          count(DISTINCT if(e.event='$pageview', e.properties.$session_id, NULL)) AS uv,
          count(DISTINCT if(e.event='$pageview' AND fp.first_pageview_day = date, e.person_id, NULL)) AS new_uv,
          countIf(e.event='landing:cta_click') AS landing_cta_clicks,
          count(DISTINCT if(e.event='landing:cta_click', e.person_id, NULL)) AS landing_cta_users,
          countIf(e.event='landing:cta_click' AND fp.first_pageview_day = date) AS new_uv_landing_cta_clicks,
          count(DISTINCT if(e.event='landing:cta_click' AND fp.first_pageview_day = date, e.person_id, NULL)) AS new_uv_landing_cta_users,
          countIf(e.event='starter:arrival') AS starter_arrivals,
          countIf(e.event='starter:auth_gate_hit') AS starter_auth_gate_hits,
          countIf(e.event='usage:gate_cta_clicked') AS usage_gate_cta_clicks,
          countIf(e.event='referral:sidebar_cta_clicked') AS referral_sidebar_cta_clicks,
          countIf(e.event='auth:login_completed') AS login_completed_events,
          count(DISTINCT if(e.event='auth:login_completed', e.person_id, NULL)) AS login_completed_users
        FROM events e
        LEFT JOIN first_pageview fp ON fp.person_id = e.person_id
        WHERE e.timestamp >= toDateTime('{START_UTC:%Y-%m-%d %H:%M:%S}')
          AND e.timestamp < toDateTime('{END_UTC:%Y-%m-%d %H:%M:%S}')
          AND e.event IN (
            '$pageview','landing:cta_click','starter:arrival',
            'starter:auth_gate_hit','usage:gate_cta_clicked',
            'referral:sidebar_cta_clicked','auth:login_completed'
          )
          AND e.properties.$host='moclaw.ai'
        GROUP BY date
        ORDER BY date
        """
    )
    return write_csv(
        f"posthog_web_activation_core_{START}_{END_EXCLUSIVE}.csv",
        [
            "date",
            "uv",
            "new_uv",
            "landing_cta_clicks",
            "landing_cta_users",
            "new_uv_landing_cta_clicks",
            "new_uv_landing_cta_users",
            "starter_arrivals",
            "starter_auth_gate_hits",
            "usage_gate_cta_clicks",
            "referral_sidebar_cta_clicks",
            "login_completed_events",
            "login_completed_users",
        ],
        rows,
    )


def main() -> None:
    paths = [
        pull_google_ads_daily(),
        pull_web_activation_core(),
        pull_new_uv_cohort(),
        pull_new_uv_channel_cohort(),
        pull_registration_cohort(),
        pull_agent_quality(),
        pull_retention_activity(),
        pull_retention_subscription_segments(),
        pull_engineering(),
        pull_file_usage(),
        *pull_finance_funnel(),
        pull_finance_stripe(),
        pull_connectors(),
    ]
    for path in paths:
        print(path)


if __name__ == "__main__":
    main()
