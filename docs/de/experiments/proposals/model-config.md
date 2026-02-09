---
summary: "Exploration: Modellkonfiguration, Auth-Profile und Fallback-Verhalten"
read_when:
  - Erkundung zukünftiger Ideen zur Modellauswahl und zu Auth-Profilen
title: "Erkundung der Modellkonfiguration"
---

# Modellkonfiguration (Exploration)

Dieses Dokument hält **Ideen** für eine zukünftige Modellkonfiguration fest. Es ist keine
auslieferungsreife Spezifikation. Informationen zum aktuellen Verhalten finden Sie unter:

- [Models](/concepts/models)
- [Model failover](/concepts/model-failover)
- [OAuth + profiles](/concepts/oauth)

## Motivation

Betreiber wünschen sich:

- Mehrere Auth-Profile pro Anbieter (privat vs. beruflich).
- Eine einfache `/model`-Auswahl mit vorhersehbaren Fallbacks.
- Eine klare Trennung zwischen Textmodellen und bildfähigen Modellen.

## Mögliche Richtung (auf hoher Ebene)

- Die Modellauswahl einfach halten: `provider/model` mit optionalen Aliassen.
- Anbietern mehrere Auth-Profile mit einer expliziten Reihenfolge erlauben.
- Eine globale Fallback-Liste verwenden, sodass alle Sitzungen konsistent ausweichen.
- Bild-Routing nur dann überschreiben, wenn es explizit konfiguriert ist.

## Offene Fragen

- Sollte die Profilrotation pro Anbieter oder pro Modell erfolgen?
- Wie sollte die UI die Profilauswahl für eine Sitzung darstellen?
- Was ist der sicherste Migrationspfad von Legacy-Konfigurationsschlüsseln?
