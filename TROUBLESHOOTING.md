# Troubleshooting

## vLLM (WSL2) Connection
vLLM запускается в WSL2 Ubuntu и обслуживает модели через OpenAI-compatible HTTP API.

**Конфигурация:**
- vLLM URL: `http://172.27.192.1:8000/v1` (WSL2 IP)
- Модели: AWQ-квантизированные (хранятся в `/mnt/d/vllm_models`)
- Запуск: vLLM Manager автоматически стартует и мониторит процесс

**Возможные проблемы:**
1. WSL2 IP изменился → обновить `vllm_url` в `config/openclaw_config.json`
2. CUDA/GPU не видна → проверить `nvidia-smi` в WSL2
3. vLLM не стартует → проверить лог: `logs/vllm_startup.log`
4. Порт занят → `ss -ltnp | grep 8000` в WSL2

## Legacy: Ollama Windows to WSL Connection (deprecated)
Данная секция сохранена для справки. Ollama больше не используется — миграция на vLLM завершена 2026-03-15.
