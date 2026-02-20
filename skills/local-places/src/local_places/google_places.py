from __future__ import annotations

import logging
import os
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
        with httpx.Client(timeout=10.0) as client:
            response = client.request(
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


def search_places(request: SearchRequest) -> SearchResponse:
    url = f"{GOOGLE_PLACES_BASE_URL}/places:searchText"
    response = _request("POST", url, _build_search_body(request), _SEARCH_FIELD_MASK)

    if response.status_code >= 400:
        logger.error(
            "Google Places API error %s. response=%s",
            response.status_code,
            response.text,
        )
        raise HTTPException(
            status_code=502,
            detail=f"Google Places API error ({response.status_code}).",
        )

    try:
        payload = response.json()
    except ValueError as exc:
        logger.error(
            "Google Places API returned invalid JSON. response=%s",
            response.text,
        )
        raise HTTPException(status_code=502, detail="Invalid Google response.") from exc

    places = payload.get("places", [])
    results = []
    for place in places:
        results.append(
            PlaceSummary(
                place_id=place.get("id", ""),
                name=_parse_display_name(place.get("displayName")),
                address=place.get("formattedAddress"),
                location=_parse_lat_lng(place.get("location")),
                rating=place.get("rating"),
                price_level=_parse_price_level(place.get("priceLevel")),
                types=place.get("types"),
                open_now=_parse_open_now(place.get("currentOpeningHours")),
            )
        )

    return SearchResponse(
        results=results,
        next_page_token=payload.get("nextPageToken"),
    )


def get_place_details(place_id: str) -> PlaceDetails:
    url = f"{GOOGLE_PLACES_BASE_URL}/places/{place_id}"
    response = _request("GET", url, None, _DETAILS_FIELD_MASK)

    if response.status_code >= 400:
        logger.error(
            "Google Places API error %s. response=%s",
            response.status_code,
            response.text,
        )
        raise HTTPException(
            status_code=502,
            detail=f"Google Places API error ({response.status_code}).",
        )

    try:
        payload = response.json()
    except ValueError as exc:
        logger.error(
            "Google Places API returned invalid JSON. response=%s",
            response.text,
        )
        raise HTTPException(status_code=502, detail="Invalid Google response.") from exc

    return PlaceDetails(
        place_id=payload.get("id", place_id),
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


def resolve_locations(request: LocationResolveRequest) -> LocationResolveResponse:
    url = f"{GOOGLE_PLACES_BASE_URL}/places:searchText"
    body = {"textQuery": request.location_text, "pageSize": request.limit}
    response = _request("POST", url, body, _RESOLVE_FIELD_MASK)

    if response.status_code >= 400:
        logger.error(
            "Google Places API error %s. response=%s",
            response.status_code,
            response.text,
        )
        raise HTTPException(
            status_code=502,
            detail=f"Google Places API error ({response.status_code}).",
        )

    try:
        payload = response.json()
    except ValueError as exc:
        logger.error(
            "Google Places API returned invalid JSON. response=%s",
            response.text,
        )
        raise HTTPException(status_code=502, detail="Invalid Google response.") from exc

    places = payload.get("places", [])
    results = []
    for place in places:
        results.append(
            ResolvedLocation(
                place_id=place.get("id", ""),
                name=_parse_display_name(place.get("displayName")),
                address=place.get("formattedAddress"),
                location=_parse_lat_lng(place.get("location")),
                types=place.get("types"),
            )
        )

    return LocationResolveResponse(results=results)
