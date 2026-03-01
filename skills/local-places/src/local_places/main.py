import asyncio
import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from local_places.google_places import (
    close_async_http_client,
    close_http_client,
    get_place_details_async,
    resolve_locations_async,
    search_places_async,
)
from local_places.schemas import (
    LocationResolveRequest,
    LocationResolveResponse,
    PlaceDetails,
    SearchRequest,
    SearchResponse,
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    yield
    errors: list[BaseException] = []
    try:
        await asyncio.to_thread(close_http_client)
    except BaseException as e:
        errors.append(e)
        logger.exception("Error closing sync HTTP client during shutdown")
    try:
        await close_async_http_client()
    except BaseException as e:
        errors.append(e)
        logger.exception("Error closing async HTTP client during shutdown")
    if errors:
        raise errors[0]


app = FastAPI(
    title=os.getenv("OPENAPI_TITLE", "Local Places API"),
    servers=[{"url": os.getenv("OPENAPI_SERVER_URL", "http://localhost:8000")}],
    lifespan=lifespan,
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
async def places_search(request: SearchRequest) -> SearchResponse:
    return await search_places_async(request)


@app.get("/places/{place_id}", response_model=PlaceDetails)
async def places_details(place_id: str) -> PlaceDetails:
    return await get_place_details_async(place_id)


@app.post("/locations/resolve", response_model=LocationResolveResponse)
async def locations_resolve(request: LocationResolveRequest) -> LocationResolveResponse:
    return await resolve_locations_async(request)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("local_places.main:app", host="0.0.0.0", port=8000)
