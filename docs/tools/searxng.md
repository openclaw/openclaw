---
summary: "Web search configuration for self-hosted SearXNG"
title: "SearXNG (Self-hosted)"
---

# SearXNG (Self-hosted)

[SearXNG](https://github.com/searxng/searxng) is a free, privacy-respecting metasearch engine you can host yourself. It is the recommended choice for local or private search workflows.

## 1. Installation

The easiest way to run SearXNG is using Docker.

### Basic Run

```bash
docker run -d -p 8080:8080 --name searxng searxng/searxng
```

### Recommended Run (with persistence)

To customize SearXNG settings, mount a local folder for configuration:

```bash
mkdir -p ./searxng
docker run -d \
  -p 8080:8080 \
  -v $(pwd)/searxng:/etc/searxng \
  --name searxng \
  searxng/searxng
```

## 2. SearXNG Configuration (`settings.yml`)

OpenClaw requires SearXNG to support JSON output. You must enable it in your `settings.yml` (located in `/etc/searxng` inside the container).

### Basic Configuration

```yaml
# settings.yml
use_default_settings: true

server:
  port: 8080
  bind_address: "0.0.0.0"
  secret_key: "change_this_to_a_random_string"

search:
  formats:
    - html
    - json # CRITICAL: Must be enabled for OpenClaw
```

## 3. OpenClaw Configuration

Update your `~/.openclaw/openclaw.json` to point to your instance.

```json
{
  "tools": {
    "web": {
      "search": {
        "provider": "searxng",
        "allowPrivateNetwork": true,
        "searxng": {
          "baseUrl": "http://10.251.1.32:8080"
        }
      }
    }
  }
}
```

- **`baseUrl`**: Use the IP address or hostname of your SearXNG server. If running on the same machine as OpenClaw, you can use `http://localhost:8080`.
- **`allowPrivateNetwork`**: Set this to `true` if your SearXNG instance is on a local/private IP (like `10.x.x.x` or `192.168.x.x`) or `localhost`.

## 4. Troubleshooting

### 403 Forbidden Error

If you receive a 403 Forbidden error (e.g., when asking for weather in Mattermost), it usually indicates that SearXNG's bot-detection or the missing JSON format is blocking the request.

**Potential causes:**

- Missing `json` format in `settings.yml`.
- Server-side restrictions (rate limiting, IP blocking via the `Limiter` plugin).
- Misconfigured SearXNG instance.

#### Resolution Method 1: Modify inside the running container

1. **Identify the container:**

   ```bash
   docker ps | grep searxng
   ```

2. **Enter the container:**

   ```bash
   docker exec -it {container_name} sh
   ```

3. **Locate and edit `settings.yml`:**

   ```bash
   find / -name "settings.yml" 2>/dev/null
   vi /etc/searxng/settings.yml
   ```

   Add `json` to `formats` and comment out the `Limiter` if you are on a private network:

   ```yaml
   search:
     formats:
       - html
       - json # ← Add this

   enabled_plugins:
     # - 'Limiter' # ← Comment out for personal/private instances
     - "Basic Calculator"
     - "Hash plugin"
   ```

   > [!WARNING]
   > For public instances, keep the `Limiter` enabled. Only disable it for internal or private network use.

4. **Restart the container:**

   ```bash
   exit
   docker restart {container_name}
   ```

#### Resolution Method 2: Volume Mounting (Recommended)

Mount a host-side `settings.yml` to ensure settings persist after container updates or removals.

1. **Copy the config from the container:**

   ```bash
   docker cp {container_id}:/etc/searxng/settings.yml ~/searxng-settings.yml
   ```

2. **Edit the file on your host:**
   Add `json` to `formats` and disable `Limiter` as described in Method 1.
3. **Restart with the volume mount:**

   ```bash
   docker stop searxng
   docker rm searxng
   docker run -d \
     --name searxng \
     -p 8080:8080 \
     -v ~/searxng-settings.yml:/etc/searxng/settings.yml \
     searxng/searxng
   ```

#### Verify the fix (curl)

Verify that the JSON endpoint works manually:

```bash
curl -X GET "http://localhost:8080/search?q=test&format=json" \
  -H "User-Agent: Mozilla/5.0" \
  -H "Accept-Language: en-US,en;q=0.9"
```

If you receive a JSON response, the configuration is correct. If you still see a 403, re-examine `settings.yml`.

### Engine Errors (Timeout, Access Denied, Too Many Requests)

Self-hosted SearXNG instances often face blocking from major search engines (Google, Brave, DuckDuckGo) due to bot-detection or shared IP reputation.

**Symptoms:**

- `engine timeout` or `ConnectTimeout` in logs.
- `Access Denied`, `Too many requests`, or `Parsing Error` in the UI.
- `json.decoder.JSONDecodeError: Extra data` in the SearXNG logs.

**Resolution:**

1. **Increase Timeouts:** Some engines are slow or throttled. Increase the global and engine-specific timeouts in `settings.yml`.
2. **Disable Blocked Engines:** If an engine (like Google or Brave) consistently blocks your IP, it is better to disable it to avoid delays.
3. **Tune Engines:** Configure problematic engines explicitly.

**Example enhanced `settings.yml`:**

```yaml
# settings.yml
use_default_settings: true

server:
  port: 8080
  bind_address: "0.0.0.0"
  secret_key: "your_password_key_string"

search:
  formats:
    - html
    - json
  default_lang: "ko" # Optional: Set default search language

engines:
  # ❌ Disable engines commonly blocking IPs (Access Denied / Too Many Requests)
  - name: google
    disabled: true
  - name: brave
    disabled: true
  - name: startpage
    disabled: true
  - name: duckduckgo
    disabled: true

  # ✅ Enable stable engines with increased timeouts
  - name: bing
    timeout: 10.0
    shortcut: bi
    disabled: false
  - name: yahoo
    timeout: 10.0
    shortcut: yh
    disabled: false
  - name: mojeek
    timeout: 10.0
    shortcut: mjk
    disabled: false
  - name: qwant
    timeout: 10.0
    shortcut: qw
    disabled: false
  - name: wikipedia
    timeout: 10.0
    shortcut: wp
    disabled: false
  - name: wikidata
    timeout: 10.0
    shortcut: wd
    disabled: false

outgoing:
  request_timeout: 10.0
  pool_connections: 100
  pool_maxsize: 20
```

Restart your SearXNG container after applying these changes.

### Freshness & Language Support

SearXNG supports:

- **`freshness`**: Values (`pd`, `pw`, `pm`, `py`) map to SearXNG's `time_range` filter (`day`, `week`, `month`, `year`).
- **`language`**: ISO 639-1 language codes (e.g., `en`, `ko`, `de`) to filter results by language.

## 5. Running SearXNG at boot (systemd)

To ensure SearXNG starts automatically when your system boots, you can create a systemd service unit. While Docker containers can be set to `--restart always`, using systemd allows for better integration with other system services and logging.

**Example: `searxng.service` (Docker-based)**

1. **Create the service file:**

   ```bash
   sudo vi /etc/systemd/system/searxng.service
   ```

2. **Add the following content:**

   ```ini
   [Unit]
   Description=SearXNG Docker Container
   After=docker.service
   Requires=docker.service

   [Service]
   TimeoutStartSec=0
   Restart=always
   ExecStartPre=-/usr/bin/docker stop searxng
   ExecStartPre=-/usr/bin/docker rm searxng
   ExecStart=/usr/bin/docker run --name searxng -p 8080:8080 -v /etc/searxng/settings.yml:/etc/searxng/settings.yml searxng/searxng
   ExecStop=/usr/bin/docker stop searxng

   [Install]
   WantedBy=multi-user.target
   ```

   _(Ensure the volume path `-v` matches your actual `settings.yml` location on the host.)_

3. **Enable and start the service:**

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable searxng
   sudo systemctl start searxng
   ```
