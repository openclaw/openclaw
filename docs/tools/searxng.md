# SearXNG

[SearXNG](https://github.com/searxng/searxng) is a free internet metasearch engine which aggregates results from more than 70 search services.

## Configuration

To use SearXNG with OpenClaw, you need to configure the `baseUrl` for your self-hosted SearXNG instance.

```json
{
  "tools": {
    "web": {
      "search": {
        "provider": "searxng",
        "searxng": {
          "baseUrl": "http://your-searxng-instance:8080",
          "allowPrivateNetwork": true
        }
      }
    }
  }
}
```

## Security

By default, OpenClaw blocks search requests to private network IP addresses (SSRF protection). If you are running SearXNG on your local network or a private VPC, you must set `allowPrivateNetwork: true` in your SearXNG configuration.

Alternatively, you can enable private network access globally for all search providers:

```json
{
  "tools": {
    "web": {
      "search": {
        "allowPrivateNetwork": true
      }
    }
  }
}
```
