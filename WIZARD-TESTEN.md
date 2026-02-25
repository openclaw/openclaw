# Web-Wizard testen

## So startest du den Web-Wizard:

### Schritt 1: Gateway starten

```bash
cd /Users/dsselmanovic/openclaw
node activi.mjs gateway --port 18789
```

### Schritt 2: Dashboard mit Onboarding-Parameter öffnen

**Im Browser öffnen:**
```
http://127.0.0.1:18789/?onboarding=1
```

**Oder mit CLI:**
```bash
open "http://127.0.0.1:18789/?onboarding=1"
```

### Schritt 3: Wizard sollte automatisch starten

Der Web-Wizard wird als Full-Screen Overlay angezeigt mit:
- ✅ Animiertes Video-Logo im Welcome-Step
- ✅ 7-Schritt-Wizard (Welcome, API-Key, Workspace, Gateway, Channels, Agents, Summary)
- ✅ Progress-Bar oben
- ✅ Navigation (Zurück/Weiter)

---

## Unterschied: CLI vs Web Wizard

| Feature | CLI-Wizard | Web-Wizard |
|---------|------------|------------|
| **Start** | `activi onboard` | `http://127.0.0.1:18789/?onboarding=1` |
| **UI** | Terminal (Text) | Browser (Full-Screen Overlay) |
| **Logo** | ASCII Art | Animiertes Video |
| **Navigation** | Enter/Arrow Keys | Buttons (Zurück/Weiter) |
| **Styling** | Terminal-Farben | Modern UI mit CSS |

---

## Troubleshooting

### Wizard startet nicht?

1. **Prüfe Gateway-Status:**
   ```bash
   node activi.mjs gateway status
   ```

2. **Prüfe URL-Parameter:**
   - Muss `?onboarding=1` enthalten
   - Oder `?onboarding=true`

3. **Prüfe Browser-Konsole:**
   - F12 öffnen
   - Nach Fehlern suchen

### Gateway läuft nicht?

```bash
# Gateway starten
node activi.mjs gateway --port 18789 --verbose

# In neuem Terminal: Dashboard öffnen
open "http://127.0.0.1:18789/?onboarding=1"
```

---

## Nächste Schritte

Nach erfolgreichem Wizard-Test:
1. ✅ Feedback geben (was gefällt/nicht gefällt)
2. ✅ Weitere Features hinzufügen (z.B. Monitoring-View)
3. ✅ Backend-Integration vervollständigen (Broadcast, Team-Management)
