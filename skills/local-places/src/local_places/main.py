import logging
import os

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from local_places.google_places import get_place_details, resolve_locations, search_places
from local_places.schemas import (
    LocationResolveRequest,
    LocationResolveResponse,
    PlaceDetails,
    SearchRequest,
    SearchResponse,
)

app = FastAPI(
    title="My API",
    servers=[{"url": os.getenv("OPENAPI_SERVER_URL", "http://maxims-macbook-air:8000")}],
)
logger = logging.getLogger("local_places.validation")


@app.get("/ping")
def ping() -> dict[str, str]:
    return {"message": "pong"}


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    logger.error(
        "Validation error on %s %s. body=%s errors=%s",
        request.method,
        request.url.path,
        exc.body,
        exc.errors(),
    )
    return JSONResponse(
        status_code=422,
        content=jsonable_encoder({"detail": exc.errors()}),
    )


@app.post("/places/search", response_model=SearchResponse)
def places_search(request: SearchRequest) -> SearchResponse:
    return search_places(request)


@app.get("/places/{place_id}", response_model=PlaceDetails)
def places_details(place_id: str) -> PlaceDetails:
    return get_place_details(place_id)


@app.post("/locations/resolve", response_model=LocationResolveResponse)
def locations_resolve(request: LocationResolveRequest) -> LocationResolveResponse:
    return resolve_locations(request)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("local_places.main:app", host="0.0.0.0", port=8000)
