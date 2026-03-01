from __future__ import annotations

import asyncio
import logging
import os
import threading
from typing import Any

import httpx
from fastapi import HTTPException

from local_places.schemas import (
    LatLng,
    LocationResolveRequest,
    LocationResolveResponse,
    PlaceDetails,
    PlaceSummary,
    ResolvedLocation,
    SearchRequest,
    SearchResponse,
)

GOOGLE_PLACES_BASE_URL = os.getenv(
    "GOOGLE_PLACES_BASE_URL", "https://places.googleapis.com/v1"
)
logger = logging.getLogger("local_places.google_places")

# Lazily initialised; created on first request so import has no side effects.
_http_client: httpx.Client | None = None
_http_client_lock = threading.Lock()


def get_http_client() -> httpx.Client:
    global _http_client
    with _http_client_lock:
        if _http_client is None:
            _http_client = httpx.Client(timeout=10.0)
        return _http_client


def close_http_client() -> None:
    global _http_client
    with _http_client_lock:
        if _http_client is not None:
            _http_client.close()
            _http_client = None


# Async client for non-blocking I/O in FastAPI route handlers.
# Lock is lazily created inside async code so it is bound to the current event loop.
_async_http_client: httpx.AsyncClient | None = None
_async_http_client_lock: asyncio.Lock | None = None
_async_http_client_lock_guard = threading.Lock()


async def get_async_http_client() -> httpx.AsyncClient:
    global _async_http_client, _async_http_client_lock
    if _async_http_client_lock is None:
        with _async_http_client_lock_guard:
            if _async_http_client_lock is None:
                _async_http_client_lock = asyncio.Lock()
    async with _async_http_client_lock:
        if _async_http_client is None:
            _async_http_client = httpx.AsyncClient(timeout=10.0)
        return _async_http_client


async def close_async_http_client() -> None:
    global _async_http_client
    if _async_http_client_lock is None:
        return
    async with _async_http_client_lock:
        if _async_http_client is not None:
            await _async_http_client.aclose()
            _async_http_client = None


async def _request_async(
    method: str, url: str, payload: dict[str, Any] | None, field_mask: str
) -> _GoogleResponse:
    try:
        client = await get_async_http_client()
        response = await client.request(
            method=method,
            url=url,
            headers=_api_headers(field_mask),
            json=payload,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Google Places API unavailable.") from exc
    return _GoogleResponse(response)


_PRICE_LEVEL_TO_ENUM = {
    0: "PRICE_LEVEL_FREE",
    1: "PRICE_LEVEL_INEXPENSIVE",
    2: "PRICE_LEVEL_MODERATE",
    3: "PRICE_LEVEL_EXPENSIVE",
    4: "PRICE_LEVEL_VERY_EXPENSIVE",
}
_ENUM_TO_PRICE_LEVEL = {value: key for key, value in _PRICE_LEVEL_TO_ENUM.items()}

_SEARCH_FIELD_MASK = (
    "places.id,"
    "places.displayName,"
    "places.formattedAddress,"
    "places.location,"
    "places.rating,"
    "places.priceLevel,"
    "places.types,"
    "places.currentOpeningHours,"
    "nextPageToken"
)

_DETAILS_FIELD_MASK = (
    "id,"
    "displayName,"
    "formattedAddress,"
    "location,"
    "rating,"
    "priceLevel,"
    "types,"
    "regularOpeningHours,"
    "currentOpeningHours,"
    "nationalPhoneNumber,"
    "websiteUri"
)

_RESOLVE_FIELD_MASK = (
    "places.id,"
    "places.displayName,"
    "places.formattedAddress,"
    "places.location,"
    "places.types"
)


class _GoogleResponse:
    def __init__(self, response: httpx.Response):
        self.status_code = response.status_code
        self._response = response

    def json(self) -> dict[str, Any]:
        return self._response.json()

    @property
    def text(self) -> str:
        return self._response.text


def _api_headers(field_mask: str) -> dict[str, str]:
    api_key = os.getenv("GOOGLE_PLACES_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="GOOGLE_PLACES_API_KEY is not set.",
        )
    return {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": field_mask,
    }


def _request(
    method: str, url: str, payload: dict[str, Any] | None, field_mask: str
) -> _GoogleResponse:
    try:
        response = get_http_client().request(
            method=method,
            url=url,
            headers=_api_headers(field_mask),
            json=payload,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Google Places API unavailable.") from exc

    return _GoogleResponse(response)


def _build_text_query(request: SearchRequest) -> str:
    keyword = request.filters.keyword if request.filters else None
    if keyword:
        return f"{request.query} {keyword}".strip()
    return request.query


def _build_search_body(request: SearchRequest) -> dict[str, Any]:
    body: dict[str, Any] = {
        "textQuery": _build_text_query(request),
        "pageSize": request.limit,
    }

    if request.page_token:
        body["pageToken"] = request.page_token

    if request.location_bias:
        body["locationBias"] = {
            "circle": {
                "center": {
                    "latitude": request.location_bias.lat,
                    "longitude": request.location_bias.lng,
                },
                "radius": request.location_bias.radius_m,
            }
        }

    if request.filters:
        filters = request.filters
        if filters.types:
            body["includedType"] = filters.types[0]
        if filters.open_now is not None:
            body["openNow"] = filters.open_now
        if filters.min_rating is not None:
            body["minRating"] = filters.min_rating
        if filters.price_levels:
            body["priceLevels"] = [
                _PRICE_LEVEL_TO_ENUM[level] for level in filters.price_levels
            ]

    return body


def _parse_lat_lng(raw: dict[str, Any] | None) -> LatLng | None:
    if not raw:
        return None
    latitude = raw.get("latitude")
    longitude = raw.get("longitude")
    if latitude is None or longitude is None:
        return None
    return LatLng(lat=latitude, lng=longitude)


def _parse_display_name(raw: dict[str, Any] | None) -> str | None:
    if not raw:
        return None
    return raw.get("text")


def _parse_open_now(raw: dict[str, Any] | None) -> bool | None:
    if not raw:
        return None
    return raw.get("openNow")


def _parse_hours(raw: dict[str, Any] | None) -> list[str] | None:
    if not raw:
        return None
    return raw.get("weekdayDescriptions")


def _parse_price_level(raw: str | None) -> int | None:
    if not raw:
        return None
    return _ENUM_TO_PRICE_LEVEL.get(raw)


def _validate_and_parse_json(response: _GoogleResponse, context: str) -> dict[str, Any]:
    """Check status, log on error, parse JSON; raise HTTPException on failure."""
    if response.status_code >= 400:
        logger.error(
            "Google Places API error %s (context=%s). response=%s",
            response.status_code,
            context,
            response.text,
        )
        raise HTTPException(
            status_code=502,
            detail=f"Google Places API error ({response.status_code}).",
        )
    try:
        return response.json()
    except ValueError as exc:
        logger.error(
            "Google Places API returned invalid JSON (context=%s). response=%s",
            context,
            response.text,
        )
        raise HTTPException(status_code=502, detail="Invalid Google response.") from exc


def _parse_search_results(payload: dict[str, Any]) -> SearchResponse:
    places = payload.get("places", [])
    results = [
        PlaceSummary(
            place_id=p.get("id", ""),
            name=_parse_display_name(p.get("displayName")),
            address=p.get("formattedAddress"),
            location=_parse_lat_lng(p.get("location")),
            rating=p.get("rating"),
            price_level=_parse_price_level(p.get("priceLevel")),
            types=p.get("types"),
            open_now=_parse_open_now(p.get("currentOpeningHours")),
        )
        for p in places
    ]
    return SearchResponse(
        results=results,
        next_page_token=payload.get("nextPageToken"),
    )


def _parse_place_details(payload: dict[str, Any], place_id: str | None = None) -> PlaceDetails:
    return PlaceDetails(
        place_id=payload.get("id", place_id or ""),
        name=_parse_display_name(payload.get("displayName")),
        address=payload.get("formattedAddress"),
        location=_parse_lat_lng(payload.get("location")),
        rating=payload.get("rating"),
        price_level=_parse_price_level(payload.get("priceLevel")),
        types=payload.get("types"),
        phone=payload.get("nationalPhoneNumber"),
        website=payload.get("websiteUri"),
        hours=_parse_hours(payload.get("regularOpeningHours")),
        open_now=_parse_open_now(payload.get("currentOpeningHours")),
    )


def _parse_resolve_results(payload: dict[str, Any]) -> LocationResolveResponse:
    places = payload.get("places", [])
    results = [
        ResolvedLocation(
            place_id=p.get("id", ""),
            name=_parse_display_name(p.get("displayName")),
            address=p.get("formattedAddress"),
            location=_parse_lat_lng(p.get("location")),
            types=p.get("types"),
        )
        for p in places
    ]
    return LocationResolveResponse(results=results)


def search_places(request: SearchRequest) -> SearchResponse:
    url = f"{GOOGLE_PLACES_BASE_URL}/places:searchText"
    response = _request("POST", url, _build_search_body(request), _SEARCH_FIELD_MASK)
    payload = _validate_and_parse_json(response, "search")
    return _parse_search_results(payload)


def get_place_details(place_id: str) -> PlaceDetails:
    url = f"{GOOGLE_PLACES_BASE_URL}/places/{place_id}"
    response = _request("GET", url, None, _DETAILS_FIELD_MASK)
    payload = _validate_and_parse_json(response, "place_details")
    return _parse_place_details(payload, place_id)


def resolve_locations(request: LocationResolveRequest) -> LocationResolveResponse:
    url = f"{GOOGLE_PLACES_BASE_URL}/places:searchText"
    body = {"textQuery": request.location_text, "pageSize": request.limit}
    response = _request("POST", url, body, _RESOLVE_FIELD_MASK)
    payload = _validate_and_parse_json(response, "resolve")
    return _parse_resolve_results(payload)


async def search_places_async(request: SearchRequest) -> SearchResponse:
    url = f"{GOOGLE_PLACES_BASE_URL}/places:searchText"
    response = await _request_async(
        "POST", url, _build_search_body(request), _SEARCH_FIELD_MASK
    )
    payload = _validate_and_parse_json(response, "search")
    return _parse_search_results(payload)


async def get_place_details_async(place_id: str) -> PlaceDetails:
    url = f"{GOOGLE_PLACES_BASE_URL}/places/{place_id}"
    response = await _request_async("GET", url, None, _DETAILS_FIELD_MASK)
    payload = _validate_and_parse_json(response, "place_details")
    return _parse_place_details(payload, place_id)


async def resolve_locations_async(
    request: LocationResolveRequest,
) -> LocationResolveResponse:
    url = f"{GOOGLE_PLACES_BASE_URL}/places:searchText"
    body = {"textQuery": request.location_text, "pageSize": request.limit}
    response = await _request_async("POST", url, body, _RESOLVE_FIELD_MASK)
    payload = _validate_and_parse_json(response, "resolve")
    return _parse_resolve_results(payload)
