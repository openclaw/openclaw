---
name: flutter-app
description: Flutter mobile app template principles. Riverpod, Go Router, clean architecture.
---

# Flutter App Template

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Flutter 3.x |
| Language | Dart 3.x |
| State | Riverpod 2.0 |
| Navigation | Go Router |
| HTTP | Dio |
| Storage | Hive |

---

## Directory Structure

```
project_name/
├── lib/
│   ├── main.dart
│   ├── app.dart
│   ├── core/
│   │   ├── constants/
│   │   ├── theme/
│   │   ├── router/
│   │   └── utils/
│   ├── features/
│   │   ├── auth/
│   │   │   ├── data/
│   │   │   ├── domain/
│   │   │   └── presentation/
│   │   └── home/
│   ├── shared/
│   │   ├── widgets/
│   │   └── providers/
│   └── services/
│       ├── api/
│       └── storage/
├── test/
└── pubspec.yaml
```

---

## Architecture Layers

| Layer | Contents |
|-------|----------|
| Presentation | Screens, Widgets, Providers |
| Domain | Entities, Use Cases |
| Data | Repositories, Models |

---

## Key Packages

| Package | Purpose |
|---------|---------|
| flutter_riverpod | State management |
| riverpod_annotation | Code generation |
| go_router | Navigation |
| dio | HTTP client |
| freezed | Immutable models |
| hive | Local storage |

---

## Setup Steps

1. `flutter create {{name}} --org com.{{bundle}}`
2. Update `pubspec.yaml`
3. `flutter pub get`
4. Run code generation: `dart run build_runner build`
5. `flutter run`

---

## Best Practices

- Feature-first folder structure
- Riverpod for state, React Query pattern for server state
- Freezed for immutable data classes
- Go Router for declarative navigation
- Material 3 theming
