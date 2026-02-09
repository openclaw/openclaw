---
summary: "Eksploracja: konfiguracja modeli, profile uwierzytelniania i zachowanie mechanizmu awaryjnego"
read_when:
  - Eksplorowanie przyszłych pomysłów dotyczących wyboru modeli i profili uwierzytelniania
title: "Eksploracja konfiguracji modeli"
---

# Konfiguracja modeli (eksploracja)

Ten dokument przedstawia **pomysły** dotyczące przyszłej konfiguracji modeli. Nie jest to
specyfikacja produkcyjna. Aktualne zachowanie opisano w:

- [Modele](/concepts/models)
- [Przełączanie awaryjne modeli](/concepts/model-failover)
- [OAuth + profile](/concepts/oauth)

## Motywacja

Operatorzy chcą:

- Wielu profili uwierzytelniania na dostawcę (osobiste vs służbowe).
- Prostego wyboru `/model` z przewidywalnymi mechanizmami awaryjnymi.
- Wyraźnego rozdzielenia między modelami tekstowymi a modelami obsługującymi obrazy.

## Możliwy kierunek (wysoki poziom)

- Zachować prostotę wyboru modelu: `provider/model` z opcjonalnymi aliasami.
- Pozwolić dostawcom na posiadanie wielu profili uwierzytelniania z jawną kolejnością.
- Użyć globalnej listy awaryjnej, aby wszystkie sesje przełączały się w spójny sposób.
- Nadpisywać routowanie obrazów wyłącznie wtedy, gdy zostanie to jawnie skonfigurowane.

## Otwarte pytania

- Czy rotacja profili powinna być per dostawca czy per model?
- Jak interfejs użytkownika powinien prezentować wybór profilu dla sesji?
- Jaka jest najbezpieczniejsza ścieżka migracji z kluczy konfiguracji starszego typu?
