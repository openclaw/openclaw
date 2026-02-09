---
summary: "OpenClaw के लिए वैकल्पिक Docker-आधारित सेटअप और ऑनबोर्डिंग"
read_when:
  - आप स्थानीय इंस्टॉल के बजाय एक कंटेनरीकृत Gateway चाहते हैं
  - आप Docker फ्लो को सत्यापित कर रहे हैं
title: "Docker"
---

# Docker (वैकल्पिक)

इसे केवल तभी उपयोग करें जब आप containerized gateway चाहते हों या Docker फ्लो को validate करना चाहते हों। **नहीं**: आप अपनी ही मशीन पर चला रहे हैं और सिर्फ सबसे तेज़ dev loop चाहते हैं।

## क्या Docker मेरे लिए उपयुक्त है?

- **हाँ**: आप एक पृथक, अस्थायी Gateway वातावरण चाहते हैं या ऐसे होस्ट पर OpenClaw चलाना चाहते हैं जहाँ स्थानीय इंस्टॉल संभव नहीं है।
- इसके बजाय सामान्य install फ्लो का उपयोग करें। **Sandboxing note**: agent sandboxing भी Docker का उपयोग करता है, लेकिन इसके लिए पूरे gateway को Docker में चलाने की **ज़रूरत नहीं** होती।
- देखें [Sandboxing](/gateway/sandboxing)। URL फिर से चाहिए?

यह मार्गदर्शिका कवर करती है:

- कंटेनरीकृत Gateway (Docker में पूरा OpenClaw)
- प्रति-सत्र एजेंट Sandbox (होस्ट Gateway + Docker-पृथक एजेंट टूल्स)

Sandboxing विवरण: [Sandboxing](/gateway/sandboxing)

## आवश्यकताएँ

- Docker Desktop (या Docker Engine) + Docker Compose v2
- इमेज और लॉग के लिए पर्याप्त डिस्क स्पेस

## कंटेनरीकृत Gateway (Docker Compose)

### त्वरित प्रारंभ (अनुशंसित)

रेपो रूट से:

```bash
./docker-setup.sh
```

यह स्क्रिप्ट:

- Gateway इमेज बनाती है
- ऑनबोर्डिंग विज़ार्ड चलाती है
- वैकल्पिक प्रदाता सेटअप संकेत प्रिंट करती है
- Docker Compose के माध्यम से Gateway शुरू करती है
- एक Gateway टोकन उत्पन्न करती है और उसे `.env` में लिखती है

वैकल्पिक पर्यावरण चर:

- `OPENCLAW_DOCKER_APT_PACKAGES` — बिल्ड के दौरान अतिरिक्त apt पैकेज इंस्टॉल करें
- `OPENCLAW_EXTRA_MOUNTS` — अतिरिक्त होस्ट bind mounts जोड़ें
- `OPENCLAW_HOME_VOLUME` — नामित वॉल्यूम में `/home/node` को स्थायी बनाएँ

इसके पूरा होने के बाद:

- अपने ब्राउज़र में `http://127.0.0.1:18789/` खोलें।
- Control UI में टोकन पेस्ट करें (Settings → token)।
- Need the URL again? Run `docker compose run --rm openclaw-cli dashboard --no-open`.

यह होस्ट पर config/workspace लिखता है:

- `~/.openclaw/`
- `~/.openclaw/workspace`

Running on a VPS? See [Hetzner (Docker VPS)](/install/hetzner).

### मैनुअल फ्लो (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

Note: run `docker compose ...` from the repo root. If you enabled
`OPENCLAW_EXTRA_MOUNTS` or `OPENCLAW_HOME_VOLUME`, the setup script writes
`docker-compose.extra.yml`; include it when running Compose elsewhere:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### Control UI टोकन + पेयरिंग (Docker)

यदि आपको “unauthorized” या “disconnected (1008): pairing required” दिखाई देता है, तो
एक नया डैशबोर्ड लिंक प्राप्त करें और ब्राउज़र डिवाइस को अनुमोदित करें:

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

अधिक विवरण: [Dashboard](/web/dashboard), [Devices](/cli/devices)।

### अतिरिक्त mounts (वैकल्पिक)

If you want to mount additional host directories into the containers, set
`OPENCLAW_EXTRA_MOUNTS` before running `docker-setup.sh`. This accepts a
comma-separated list of Docker bind mounts and applies them to both
`openclaw-gateway` and `openclaw-cli` by generating `docker-compose.extra.yml`.

उदाहरण:

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

नोट्स:

- macOS/Windows पर पाथ्स Docker Desktop के साथ साझा होने चाहिए।
- यदि आप `OPENCLAW_EXTRA_MOUNTS` संपादित करते हैं, तो
  अतिरिक्त compose फ़ाइल को पुनः जनरेट करने के लिए `docker-setup.sh` चलाएँ।
- `docker-compose.extra.yml` is generated. Don’t hand-edit it.

### पूरे कंटेनर होम को स्थायी बनाना (वैकल्पिक)

If you want `/home/node` to persist across container recreation, set a named
volume via `OPENCLAW_HOME_VOLUME`. This creates a Docker volume and mounts it at
`/home/node`, while keeping the standard config/workspace bind mounts. Use a
named volume here (not a bind path); for bind mounts, use
`OPENCLAW_EXTRA_MOUNTS`.

उदाहरण:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

आप इसे अतिरिक्त mounts के साथ भी संयोजित कर सकते हैं:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

नोट्स:

- यदि आप `OPENCLAW_HOME_VOLUME` बदलते हैं, तो
  अतिरिक्त compose फ़ाइल को पुनः जनरेट करने के लिए `docker-setup.sh` चलाएँ।
- नामित वॉल्यूम तब तक बना रहता है जब तक `docker volume rm <name>` से हटाया न जाए।

### अतिरिक्त apt पैकेज इंस्टॉल करें (वैकल्पिक)

If you need system packages inside the image (for example, build tools or media
libraries), set `OPENCLAW_DOCKER_APT_PACKAGES` before running `docker-setup.sh`.
This installs the packages during the image build, so they persist even if the
container is deleted.

उदाहरण:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

नोट्स:

- यह apt पैकेज नामों की स्पेस-सेपरेटेड सूची स्वीकार करता है।
- यदि आप `OPENCLAW_DOCKER_APT_PACKAGES` बदलते हैं, तो इमेज को पुनः बनाने के लिए `docker-setup.sh` चलाएँ।

### पावर-यूज़र / पूर्ण-विशेषताओं वाला कंटेनर (ऑप्ट-इन)

The default Docker image is **security-first** and runs as the non-root `node`
user. This keeps the attack surface small, but it means:

- रनटाइम पर सिस्टम पैकेज इंस्टॉल नहीं
- डिफ़ॉल्ट रूप से Homebrew नहीं
- बंडल्ड Chromium/Playwright ब्राउज़र नहीं

यदि आप अधिक पूर्ण-विशेषताओं वाला कंटेनर चाहते हैं, तो इन ऑप्ट-इन विकल्पों का उपयोग करें:

1. **`/home/node` को स्थायी बनाएँ** ताकि ब्राउज़र डाउनलोड और टूल कैश बने रहें:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **सिस्टम निर्भरताएँ इमेज में शामिल करें** (दोहराने योग्य + स्थायी):

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **`npx` के बिना Playwright ब्राउज़र इंस्टॉल करें**
   (npm override संघर्षों से बचता है):

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

यदि Playwright को सिस्टम निर्भरताएँ इंस्टॉल करनी हों, तो रनटाइम पर
`--with-deps` उपयोग करने के बजाय `OPENCLAW_DOCKER_APT_PACKAGES` के साथ इमेज को पुनः बनाएँ।

4. **Playwright ब्राउज़र डाउनलोड को स्थायी बनाएँ**:

- `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` को
  `docker-compose.yml` में सेट करें।
- सुनिश्चित करें कि `/home/node` `OPENCLAW_HOME_VOLUME` के माध्यम से स्थायी रहे, या
  `/home/node/.cache/ms-playwright` को `OPENCLAW_EXTRA_MOUNTS` के माध्यम से माउंट करें।

### अनुमतियाँ + EACCES

The image runs as `node` (uid 1000). If you see permission errors on
`/home/node/.openclaw`, make sure your host bind mounts are owned by uid 1000.

उदाहरण (Linux होस्ट):

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

यदि सुविधा के लिए आप root के रूप में चलाने का चयन करते हैं, तो आप सुरक्षा समझौते को स्वीकार करते हैं।

### तेज़ रीबिल्ड्स (अनुशंसित)

To speed up rebuilds, order your Dockerfile so dependency layers are cached.
This avoids re-running `pnpm install` unless lockfiles change:

```dockerfile
FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Cache dependencies unless package metadata changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

### चैनल सेटअप (वैकल्पिक)

CLI कंटेनर का उपयोग करके चैनल कॉन्फ़िगर करें, फिर आवश्यकता होने पर Gateway को पुनः प्रारंभ करें।

WhatsApp (QR):

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram (बॉट टोकन):

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord (बॉट टोकन):

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

डॉक्स: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord)

### OpenAI Codex OAuth (हेडलैस Docker)

If you pick OpenAI Codex OAuth in the wizard, it opens a browser URL and tries
to capture a callback on `http://127.0.0.1:1455/auth/callback`. In Docker or
headless setups that callback can show a browser error. Copy the full redirect
URL you land on and paste it back into the wizard to finish auth.

### हेल्थ चेक

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### E2E स्मोक टेस्ट (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### QR इम्पोर्ट स्मोक टेस्ट (Docker)

```bash
pnpm test:docker:qr
```

### नोट्स

- Gateway bind कंटेनर उपयोग के लिए डिफ़ॉल्ट रूप से `lan` पर होता है।
- Dockerfile CMD uses `--allow-unconfigured`; mounted config with `gateway.mode` not `local` will still start. Override CMD to enforce the guard.
- Gateway कंटेनर सत्रों के लिए source of truth है (`~/.openclaw/agents/<agentId>/sessions/`)।

## एजेंट Sandbox (होस्ट Gateway + Docker टूल्स)

डीप डाइव: [Sandboxing](/gateway/sandboxing)

### यह क्या करता है

When `agents.defaults.sandbox` is enabled, **non-main sessions** run tools inside a Docker
container. The gateway stays on your host, but the tool execution is isolated:

- स्कोप: डिफ़ॉल्ट रूप से `"agent"` (प्रति एजेंट एक कंटेनर + वर्कस्पेस)
- स्कोप: प्रति-सत्र पृथक्करण के लिए `"session"`
- प्रति-स्कोप वर्कस्पेस फ़ोल्डर `/workspace` पर माउंट
- वैकल्पिक एजेंट वर्कस्पेस एक्सेस (`agents.defaults.sandbox.workspaceAccess`)
- allow/deny टूल नीति (deny की प्राथमिकता)
- इनबाउंड मीडिया को सक्रिय sandbox वर्कस्पेस (`media/inbound/*`) में कॉपी किया जाता है ताकि टूल्स उसे पढ़ सकें ( `workspaceAccess: "rw"` के साथ यह एजेंट वर्कस्पेस में जाता है)

Warning: `scope: "shared"` disables cross-session isolation. All sessions share
one container and one workspace.

### प्रति-एजेंट sandbox प्रोफ़ाइल (मल्टी-एजेंट)

If you use multi-agent routing, each agent can override sandbox + tool settings:
`agents.list[].sandbox` and `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools`). This lets you run
mixed access levels in one gateway:

- पूर्ण एक्सेस (व्यक्तिगत एजेंट)
- केवल-पठन टूल्स + केवल-पठन वर्कस्पेस (परिवार/कार्य एजेंट)
- कोई फ़ाइलसिस्टम/शेल टूल नहीं (सार्वजनिक एजेंट)

उदाहरण, प्राथमिकता और समस्या-निवारण के लिए देखें
[Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)।

### डिफ़ॉल्ट व्यवहार

- इमेज: `openclaw-sandbox:bookworm-slim`
- प्रति एजेंट एक कंटेनर
- एजेंट वर्कस्पेस एक्सेस: `workspaceAccess: "none"` (डिफ़ॉल्ट) `~/.openclaw/sandboxes` का उपयोग करता है
  - `"ro"` sandbox वर्कस्पेस को `/workspace` पर रखता है और एजेंट वर्कस्पेस को केवल-पठन के रूप में `/agent` पर माउंट करता है ( `write`/`edit`/`apply_patch` को निष्क्रिय करता है)
  - `"rw"` एजेंट वर्कस्पेस को पढ़ने/लिखने के लिए `/workspace` पर माउंट करता है
- ऑटो-प्रून: निष्क्रिय > 24 घंटे या आयु > 7 दिन
- नेटवर्क: डिफ़ॉल्ट रूप से `none` (यदि egress चाहिए तो स्पष्ट रूप से ऑप्ट-इन करें)
- डिफ़ॉल्ट allow: `exec`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- डिफ़ॉल्ट deny: `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

### sandboxing सक्षम करें

यदि आप `setupCommand` में पैकेज इंस्टॉल करने की योजना बनाते हैं, तो ध्यान दें:

- डिफ़ॉल्ट `docker.network` `"none"` है (कोई egress नहीं)।
- `readOnlyRoot: true` पैकेज इंस्टॉल को ब्लॉक करता है।
- `user` must be root for `apt-get` (omit `user` or set `user: "0:0"`).
  OpenClaw auto-recreates containers when `setupCommand` (or docker config) changes
  unless the container was **recently used** (within ~5 minutes). Hot containers
  log a warning with the exact `openclaw sandbox recreate ...` command.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent is default)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
        },
        prune: {
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

हार्डनिंग विकल्प `agents.defaults.sandbox.docker` के अंतर्गत उपलब्ध हैं:
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits`,
`seccompProfile`, `apparmorProfile`, `dns`, `extraHosts`।

मल्टी-एजेंट: प्रति एजेंट `agents.defaults.sandbox.{docker,browser,prune}.*` को `agents.list[].sandbox.{docker,browser,prune}.*` के माध्यम से ओवरराइड करें
(`agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` जब `"shared"` हो तब अनदेखा किया जाता है)।

### डिफ़ॉल्ट sandbox इमेज बनाएँ

```bash
scripts/sandbox-setup.sh
```

यह `Dockerfile.sandbox` का उपयोग करके `openclaw-sandbox:bookworm-slim` बनाता है।

### Sandbox common इमेज (वैकल्पिक)

यदि आप सामान्य बिल्ड टूलिंग (Node, Go, Rust आदि) के साथ sandbox इमेज चाहते हैं, तो common इमेज बनाएँ:

```bash
scripts/sandbox-common-setup.sh
```

This builds `openclaw-sandbox-common:bookworm-slim`. To use it:

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### Sandbox ब्राउज़र इमेज

sandbox के भीतर ब्राउज़र टूल चलाने के लिए, ब्राउज़र इमेज बनाएँ:

```bash
scripts/sandbox-browser-setup.sh
```

This builds `openclaw-sandbox-browser:bookworm-slim` using
`Dockerfile.sandbox-browser`. The container runs Chromium with CDP enabled and
an optional noVNC observer (headful via Xvfb).

नोट्स:

- Headful (Xvfb) headless की तुलना में bot blocking को कम करता है।
- `agents.defaults.sandbox.browser.headless=true` सेट करके headless अभी भी उपयोग किया जा सकता है।
- पूर्ण डेस्कटॉप वातावरण (GNOME) की आवश्यकता नहीं है; Xvfb डिस्प्ले प्रदान करता है।

कॉन्फ़िग का उपयोग करें:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: { enabled: true },
      },
    },
  },
}
```

कस्टम ब्राउज़र इमेज:

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

सक्षम होने पर, एजेंट को मिलता है:

- एक sandbox ब्राउज़र कंट्रोल URL (`browser` टूल के लिए)
- एक noVNC URL (यदि सक्षम है और headless=false)

Remember: if you use an allowlist for tools, add `browser` (and remove it from
deny) or the tool remains blocked.
Prune rules (`agents.defaults.sandbox.prune`) apply to browser containers too.

### कस्टम sandbox इमेज

अपनी स्वयं की इमेज बनाएँ और कॉन्फ़िग को उसकी ओर इंगित करें:

```bash
docker build -t my-openclaw-sbx -f Dockerfile.sandbox .
```

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "my-openclaw-sbx" } },
    },
  },
}
```

### टूल नीति (allow/deny)

- `deny` की प्राथमिकता `allow` पर होती है।
- यदि `allow` खाली है: सभी टूल्स (deny को छोड़कर) उपलब्ध हैं।
- यदि `allow` खाली नहीं है: केवल `allow` में दिए गए टूल्स उपलब्ध हैं (deny को घटाकर)।

### प्रूनिंग रणनीति

दो विकल्प:

- `prune.idleHours`: X घंटे तक उपयोग न हुए कंटेनरों को हटाएँ (0 = निष्क्रिय)
- `prune.maxAgeDays`: X दिनों से पुराने कंटेनरों को हटाएँ (0 = निष्क्रिय)

उदाहरण:

- व्यस्त सत्र बनाए रखें लेकिन आयु सीमित करें:
  `idleHours: 24`, `maxAgeDays: 7`
- कभी प्रून न करें:
  `idleHours: 0`, `maxAgeDays: 0`

### सुरक्षा नोट्स

- हार्ड वॉल केवल **टूल्स** (exec/read/write/edit/apply_patch) पर लागू होती है।
- होस्ट-ओनली टूल्स जैसे browser/camera/canvas डिफ़ॉल्ट रूप से ब्लॉक होते हैं।
- sandbox में `browser` की अनुमति देना **पृथक्करण को तोड़ देता है** (ब्राउज़र होस्ट पर चलता है)।

## समस्या-निवारण

- इमेज गायब: [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) के साथ बिल्ड करें या `agents.defaults.sandbox.docker.image` सेट करें।
- कंटेनर नहीं चल रहा: यह मांग पर प्रति सत्र स्वतः बनाया जाएगा।
- sandbox में अनुमति त्रुटियाँ: `docker.user` को ऐसे UID:GID पर सेट करें जो आपके
  माउंट किए गए वर्कस्पेस के स्वामित्व से मेल खाता हो (या वर्कस्पेस फ़ोल्डर को chown करें)।
- Custom tools not found: OpenClaw runs commands with `sh -lc` (login shell), which
  sources `/etc/profile` and may reset PATH. Set `docker.env.PATH` to prepend your
  custom tool paths (e.g., `/custom/bin:/usr/local/share/npm-global/bin`), or add
  a script under `/etc/profile.d/` in your Dockerfile.
