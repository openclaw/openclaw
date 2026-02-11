from __future__ import annotations

import logging
import os
import re
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


def _validate_place_id(place_id: str) -> None:
    """
    Validate Google Places API place_id format to prevent path traversal.
    
    Google Place IDs are base64-like alphanumeric strings that may contain
    specific special characters (+, =, _, -). This validation prevents path
    traversal attacks (e.g., ../../../etc/passwd) while allowing all
    legitimate place_id formats.
    
    Args:
        place_id: The place ID string to validate
        
    Raises:
        HTTPException: If place_id format is invalid
        
    Note:
        This addresses SonarCloud pythonsecurity:S7044. While the URL scheme and host
        are fixed (https://places.googleapis.com), validating the place_id prevents
        any potential path manipulation and satisfies security analysis requirements.
    """
    if not place_id or not isinstance(place_id, str):
        raise HTTPException(
            status_code=400,
            detail="Invalid place_id: must be a non-empty string.",
        )
    
    # Google place IDs are typically 20-200 characters
    if len(place_id) < 10 or len(place_id) > 300:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid place_id length: {len(place_id)}. Expected 10-300 characters.",
        )
    
    # Normalize percent-encoded sequences (both lowercase and uppercase)
    # This catches attempts to bypass validation with URL encoding
    normalized = place_id.lower()
    normalized = normalized.replace('%2e', '.')
    normalized = normalized.replace('%2f', '/')
    normalized = normalized.replace('%5c', r'\\')
    
    # Check for path traversal patterns in the normalized string
    # Note: We already decoded %2e, %2f, %5c above, so we only need to check
    # for the actual characters, not the encoded forms
    traversal_patterns = [
        r'\.\.',           # Double dots (.. or %2e%2e after normalization)
        r'//',             # Double slashes (// or %2f%2f after normalization)
        r'\\\\',           # Double backslashes (\\ or %5c%5c after normalization)
        r'\.\/',           # Dot-slash (./  )
        r'\.\\',           # Dot-backslash (.\ )
    ]
    
    for pattern in traversal_patterns:
        if re.search(pattern, normalized, re.IGNORECASE):
            raise HTTPException(
                status_code=400,
                detail=f"Invalid place_id format: contains path traversal pattern.",
            )
    
    # Block dangerous special characters that could be used for injection
    # Fixed: Escaped the single quote properly
    if re.search(r"[\s?#<>|*%$&\'`;]", place_id):
        raise HTTPException(
            status_code=400,
            detail="Invalid place_id format: contains disallowed special characters.",
        )
    
    # Only allow alphanumeric characters and specific Google Place ID characters: + = _ -
    # Note: Forward slash (/) is NOT included as Google Place IDs don't contain slashes
    # Real examples: ChIJN1t_tDeuEmsRUsoyG83frY4, Ei1Tb21lIFBsYWNlIE5hbWU
    if not re.match(r'^[A-Za-z0-9+=_-]+$', place_id):
        raise HTTPException(
            status_code=400,
            detail="Invalid place_id format: must contain only alphanumeric characters and +, =, _, -",
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
    # Validate place_id to prevent path traversal (addresses SonarCloud pythonsecurity:S7044)
    _validate_place_id(place_id)
    
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
