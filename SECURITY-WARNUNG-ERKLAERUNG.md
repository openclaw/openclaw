# Sicherheitshinweis - Erklärung

## Was steht in der Warnung?

Die Security-Warnung erklärt auf Deutsch:

### Hauptpunkte:

1. **"Activi ist ein Hobby-Projekt und noch in der Beta"**
   - Das Projekt ist noch nicht fertig
   - Es kann Fehler oder unerwartetes Verhalten geben

2. **"Dieser Bot kann Dateien lesen und Aktionen ausführen"**
   - Wenn Tools aktiviert sind, kann der Agent:
     - Dateien auf deinem Computer lesen
     - Programme ausführen
     - System-Befehle ausführen
     - Im Internet kommunizieren

3. **"Ein schlechter Prompt kann ihn dazu bringen, unsichere Dinge zu tun"**
   - Wenn jemand einen böswilligen Prompt schickt, könnte der Agent:
     - Dateien löschen
     - Sensible Daten lesen
     - Unerwünschte Aktionen ausführen

4. **"Wenn du dich mit Sicherheit nicht auskennst, führe Activi nicht aus"**
   - Du solltest Grundkenntnisse in IT-Sicherheit haben
   - Oder jemanden fragen, der sich auskennt

### Empfohlene Sicherheitsmaßnahmen:

1. **Pairing/Allowlists + Mention-Gating**
   - Nur bestimmte Personen können den Bot nutzen
   - Der Bot reagiert nur, wenn er explizit erwähnt wird

2. **Sandbox + Tools mit minimalen Berechtigungen**
   - Der Bot läuft in einer isolierten Umgebung
   - Er hat nur die minimal nötigen Rechte

3. **Geheimnisse außerhalb des erreichbaren Dateisystems**
   - API-Keys, Passwörter etc. nicht dort speichern, wo der Bot sie lesen kann

4. **Stärkstes verfügbares Modell verwenden**
   - Bessere Modelle sind weniger anfällig für Prompt-Injection

5. **Regelmäßig Security-Audit ausführen**
   ```bash
   activi security audit --deep
   activi security audit --fix
   ```

## Warum diese Warnung?

- **Rechtliche Absicherung**: Der Entwickler warnt dich vor Risiken
- **Bewusstsein schaffen**: Du solltest wissen, was du tust
- **Best Practices**: Empfehlungen für sichere Nutzung

## Was bedeutet "inhärent riskant"?

- AI-Agents mit Tools sind grundsätzlich riskant
- Sie können mächtige Aktionen ausführen
- Ein Fehler oder böswilliger Prompt kann Schaden anrichten
- Das ist nicht spezifisch für Activi, sondern gilt für alle AI-Agent-Systeme

## Sollte ich Activi nutzen?

**Ja, wenn:**
- Du verstehst die Risiken
- Du weißt, wie du es sicher konfigurierst
- Du die empfohlenen Sicherheitsmaßnahmen befolgst

**Nein, wenn:**
- Du dich mit IT-Sicherheit nicht auskennst
- Du keine Zeit hast, dich einzulesen
- Du sensible Daten/Systeme hast, die geschützt werden müssen
