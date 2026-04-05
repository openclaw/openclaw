# Troubleshooting

## OpenRouter API Connection

Бот использует OpenRouter API для облачного LLM-инференса.

**Конфигурация:**

- OpenRouter API: настраивается в `config/openclaw_config.json` (секция `system.openrouter`)
- Модели: облачные (multi-model routing через SmartModelRouter)

**Возможные проблемы:**

1. Rate limit exceeded → включается retry с exponential backoff
2. API key невалидный → проверить `OPENROUTER_API_KEY` в `.env`
3. Модель недоступна → SmartModelRouter переключится на fallback модель

## Legacy: Local Inference (deprecated)

Локальный инференс больше не используется — миграция на cloud-only (OpenRouter) завершена.
