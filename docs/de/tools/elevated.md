---
summary: "„Erhöhter Ausführungsmodus und /elevated‑Direktiven“"
read_when:
  - Anpassen der Standardwerte des erhöhten Modus, der Allowlists oder des Verhaltens von Slash‑Commands
title: "„Erhöhter Modus“"
---

# Erhöhter Modus (/elevated‑Direktiven)

## Was er tut

- `/elevated on` läuft auf dem Gateway-Host und behält Ausführungsfreigaben bei (gleich wie `/elevated ask`).
- `/elevated full` läuft auf dem Gateway-Host **und** genehmigt exec automatisch (überspringt Ausführungsfreigaben).
- `/elevated ask` läuft auf dem Gateway-Host, behält aber Ausführungsfreigaben bei (gleich wie `/elevated on`).
- `on`/`ask` erzwingen **nicht** `exec.security=full`; die konfigurierte Sicherheits-/Abfrage‑Richtlinie gilt weiterhin.
- Ändert das Verhalten nur, wenn der Agent **sandboxed** ist (ansonsten läuft exec bereits auf dem Host).
- Direktivenformen: `/elevated on|off|ask|full`, `/elev on|off|ask|full`.
- Es werden nur `on|off|ask|full` akzeptiert; alles andere gibt einen Hinweis zurück und ändert den Zustand nicht.

## Was er steuert (und was nicht)

- **Verfügbarkeits‑Gates**: `tools.elevated` ist die globale Basis. `agents.list[].tools.elevated` kann den erhöhten Modus pro Agent weiter einschränken (beide müssen erlauben).
- **Pro‑Sitzungs‑Status**: `/elevated on|off|ask|full` setzt die Stufe des erhöhten Modus für den aktuellen Sitzungsschlüssel.
- **Inline‑Direktive**: `/elevated on|ask|full` innerhalb einer Nachricht gilt nur für diese Nachricht.
- **Gruppen**: In Gruppenchats werden erhöhte Direktiven nur berücksichtigt, wenn der Agent erwähnt wird. Reine Befehlsnachrichten, die die Erwähnungspflicht umgehen, werden als erwähnt behandelt.
- **Host‑Ausführung**: erhöht erzwingt `exec` auf dem Gateway-Host; `full` setzt außerdem `security=full`.
- **Freigaben**: `full` überspringt Ausführungsfreigaben; `on`/`ask` berücksichtigen sie, wenn Allowlist-/Abfrage‑Regeln dies verlangen.
- **Nicht‑sandboxed Agents**: keine Auswirkung auf den Ort; betrifft nur Gating, Protokollierung und Status.
- **Werkzeugrichtlinie gilt weiterhin**: Wenn `exec` durch die Werkzeugrichtlinie verweigert ist, kann erhöht nicht verwendet werden.
- **Getrennt von `/exec`**: `/exec` passt pro‑Sitzungs‑Standardwerte für autorisierte Absender an und erfordert keinen erhöhten Modus.

## Auflösungsreihenfolge

1. Inline‑Direktive in der Nachricht (gilt nur für diese Nachricht).
2. Sitzungs‑Override (gesetzt durch Senden einer reinen Direktiven‑Nachricht).
3. Globaler Standard (`agents.defaults.elevatedDefault` in der Konfiguration).

## Festlegen eines Sitzungsstandards

- Senden Sie eine Nachricht, die **nur** aus der Direktive besteht (Leerzeichen erlaubt), z. B. `/elevated full`.
- Es wird eine Bestätigungsantwort gesendet (`Elevated mode set to full...` / `Elevated mode disabled.`).
- Wenn erhöhter Zugriff deaktiviert ist oder der Absender nicht auf der genehmigten Allowlist steht, antwortet die Direktive mit einem umsetzbaren Fehler und ändert den Sitzungsstatus nicht.
- Senden Sie `/elevated` (oder `/elevated:`) ohne Argument, um die aktuelle Stufe des erhöhten Modus anzuzeigen.

## Verfügbarkeit + Allowlists

- Feature‑Gate: `tools.elevated.enabled` (der Standard kann per Konfiguration deaktiviert sein, selbst wenn der Code dies unterstützt).
- Absender‑Allowlist: `tools.elevated.allowFrom` mit anbieter­spezifischen Allowlists (z. B. `discord`, `whatsapp`).
- Pro‑Agent‑Gate: `agents.list[].tools.elevated.enabled` (optional; kann nur weiter einschränken).
- Pro‑Agent‑Allowlist: `agents.list[].tools.elevated.allowFrom` (optional; wenn gesetzt, muss der Absender **sowohl** die globale als auch die pro‑Agent‑Allowlist erfüllen).
- Discord‑Fallback: Wenn `tools.elevated.allowFrom.discord` weggelassen wird, wird die Liste `channels.discord.dm.allowFrom` als Fallback verwendet. Setzen Sie `tools.elevated.allowFrom.discord` (auch `[]`), um dies zu überschreiben. Pro‑Agent‑Allowlists verwenden den Fallback **nicht**.
- Alle Gates müssen bestehen; andernfalls wird erhöht als nicht verfügbar behandelt.

## Protokollierung + Status

- Erhöhte exec Anrufe werden auf Info-Ebene protokolliert.
- Der Sitzungsstatus enthält den erhöhten Modus (z. B. `elevated=ask`, `elevated=full`).
