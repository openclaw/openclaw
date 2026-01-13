---
summary: "Google Maps tool for directions, places search, and geocoding"
read_when:
  - Using location-based features
  - Getting directions between places
  - Finding nearby restaurants, gas stations, etc.
  - Converting coordinates to addresses
---

# Maps

Clawdbot can use Google Maps to get directions, search for nearby places, and
convert coordinates to addresses (reverse geocoding).

Beginner view:
- Get **driving/walking/transit directions** between any two locations
- Find **nearby places** like restaurants, gas stations, pharmacies
- Convert **location pins** (lat/lng) to human-readable addresses

## What you get

- Route information with distance, duration, and step-by-step directions
- Nearby place search with ratings, addresses, and open status
- Reverse geocoding for WhatsApp/Telegram location pins

## Quick start

The maps tool is available to the agent when a Google Maps API key is configured.
There's no CLI command—it's an agent-only tool.

Example agent usage:
```
maps: action=directions, origin="Central Station", destination="Airport", mode="transit"
maps: action=places, latitude=48.137, longitude=11.576, type="restaurant", radius=500
maps: action=geocode, latitude=48.137, longitude=11.576
```

## Configuration

Set your Google Maps API key via one of these methods (in priority order):

1. **Config file** (`~/.clawdbot/clawdbot.json`):
```json5
{
  skills: {
    entries: {
      "google-maps": {
        apiKey: "your-api-key"
      }
    }
  }
}
```

2. **Environment variable**:
```bash
export GOOGLE_MAPS_API_KEY="your-api-key"
```

3. **Secret file** (`~/.clawdbot/secrets/google-maps-api-key.txt`):
```
your-api-key
```

## Getting a Google Maps API key

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Enable the following APIs:
   - Directions API
   - Places API
   - Geocoding API
4. Create an API key under "APIs & Services" → "Credentials"
5. Optionally restrict the key to these APIs for security

## Tool actions

### `directions`

Get route information between two locations.

Parameters:
- `origin` (required): Starting point (address or `lat,lng` format)
- `destination` (required): Ending point (address or `lat,lng` format)
- `mode`: Travel mode—`driving` (default), `walking`, `bicycling`, `transit`

Returns:
- Distance and duration
- Step-by-step directions
- Route summary

### `places`

Search for nearby places by type or keyword.

Parameters:
- `latitude` (required): Center point latitude
- `longitude` (required): Center point longitude
- `type`: Place type filter (`restaurant`, `gas_station`, `cafe`, `pharmacy`, etc.)
- `keyword`: Free-text search term
- `radius`: Search radius in meters (default: 1000, max: 50000)
- `maxResults`: Maximum results to return (default: 10, max: 20)

Returns:
- Place name, address, and coordinates
- Rating and price level (when available)
- Open/closed status

### `geocode`

Convert coordinates to a human-readable address (reverse geocoding).

Parameters:
- `latitude` (required): Latitude coordinate
- `longitude` (required): Longitude coordinate

Returns:
- Formatted address
- Address components (street, city, country, etc.)

## Use cases

**WhatsApp location pins**: When a user sends a location pin, the agent receives
coordinates. Use `geocode` to convert them to an address, then `places` to find
nearby points of interest.

**Trip planning**: Use `directions` to get travel times between locations with
different transport modes.

**Local recommendations**: Use `places` with a keyword like "best pizza" to find
highly-rated options nearby.

## Disabling the tool

To disable the maps tool, remove the API key or use tool policies:

```json5
{
  tools: { deny: ["maps"] }
}
```
