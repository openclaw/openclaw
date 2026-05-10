# 🐺 ALPHABET HARVESTER - Uppsetning

## Hvernig á að keyra

### 1. Start Docker Compose

```bash
cd c:\Users\finnu\Documents\GitHub\openclaw
docker-compose up --build
```

### 2. Opnaðu UI

Farðu á: http://localhost:5173

Þú munt sjá:

- ✅ **Rauntíma log feed** - Öll activity í rauntíma
- ✅ **Target list** - Allar síður sem verið er að skanna
- ✅ **Worker stats** - Fjöldi workers, active, completed, failed
- ✅ **Live updates** - WebSocket tengingu fyrir instant updates

## API Endpoints

### GET /api/targets

Sækir lista af öllum targets og stats

```bash
curl http://localhost:8080/api/targets
```

### POST /api/targets

Bætir við nýjum target

```bash
curl -X POST http://localhost:8080/api/targets \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/newpage"}'
```

### POST /api/workers/scale

Breytir fjölda workers (1-20)

```bash
curl -X POST http://localhost:8080/api/workers/scale \
  -H "Content-Type: application/json" \
  -d '{"workers": 10}'
```

### WebSocket: ws://localhost:8080/api/logs/stream

Tengist fyrir rauntíma logs

## Configuration

### Fjöldi Workers

Breyttu `HARVESTER_WORKERS` í `docker-compose.yml`:

```yaml
environment:
  - HARVESTER_WORKERS=5 # Hækkaðu þetta!
```

**Hversu marga workers geturðu keyrt?**

- Docker Desktop default: **5-8 workers**
- Með 2 CPU límit: **10 workers**
- Með 4 CPU límit: **20 workers**

Til að hækka CPU limits í `docker-compose.yml`:

```yaml
deploy:
  resources:
    limits:
      cpus: "4" # Hækkaðu!
      memory: 2G
```

### Bæta við eigin targets

Breyttu `DEFAULT_TARGETS` í `harvester-server.mjs`:

```javascript
const DEFAULT_TARGETS = [
  { url: "https://yoursite.com/page1", status: "pending", progress: 0 },
  { url: "https://yoursite.com/page2", status: "pending", progress: 0 },
  // ... bættu við fleiri
];
```

## Troubleshooting

### Docker er að klikka með marga workers

```bash
# Skoðaðu resource usage
docker stats

# Hækkaðu Docker Desktop memory:
# Settings → Resources → Memory: 4GB+
```

### WebSocket tengist ekki

Athugaðu að port 8080 sé opinn og harvester server sé að keyra:

```bash
curl http://localhost:8080/api/health
```

### UI sýnir ekki logs

1. Opnaðu Developer Console (F12)
2. Athugaðu WebSocket tengingu
3. Verify API er að svara: `curl http://localhost:8080/api/logs`

## Performance Tips

### 🚀 Hækka workers án þess að klessa Docker:

1. **Stagger startup**: Ekki starta alla workers samtímis
2. **Request timeout**: Haltu `requestTimeout` lágu (30s)
3. **Memory limit**: Hækkaðu Docker memory í 2GB+
4. **CPU limit**: Notaðu `cpus: '2'` eða meira

### ⚡ Best practices:

- 5 workers = góður starting point
- 10 workers = þarfnast 2 CPU + 1GB RAM
- 20 workers = þarfnast 4 CPU + 2GB RAM
- Með meira en 20 workers, íhugaðu að nota external queue (Redis/RabbitMQ)

## Þróun

Ef þú vilt þróa locally án Docker:

```bash
# Backend
cd c:\Users\finnu\Documents\GitHub\openclaw
cp harvester-package.json package.json
npm install
HARVESTER_WORKERS=3 node harvester-server.mjs

# Frontend (í nýjum terminal)
cd c:\Users\finnu\control-ui
npm install
npm run dev
```

Farðu á: http://localhost:5173

## BÚMM! 💥

Þú ert núna með:

- ✅ Real-time log feed á UI
- ✅ Target list með status
- ✅ 5 concurrent workers
- ✅ API til að scale workers dynamically
- ✅ WebSocket fyrir instant updates

**Njóttu! 🐺🇮🇸**
