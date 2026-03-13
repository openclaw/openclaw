#!/bin/bash
# Скрипт для читання думок агента в реальному часі (Agent Observability)
LOG_FILE=~/.openclaw/memory/traces/thoughts.jsonl

echo "🚀 Запускаю Рентген Думок Агента..."
echo "Очікую на нові думки в $LOG_FILE"
echo "Для виходу натисни Ctrl+C"
echo "---------------------------------------------------"

# Створюємо файл, щоб tail не сварився, якщо агента ще не запускали
mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"

# Читаємо jsonl і форматуємо за допомогою node (щоб не залежати від jq)
tail -f "$LOG_FILE" | node -e '
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });

const COLORS = {
  dim: "\x1b[90m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  reset: "\x1b[0m"
};

rl.on("line", (line) => {
  try {
    if (!line.trim()) return;
    const t = JSON.parse(line);
    const time = new Date(t.timestamp).toLocaleTimeString("uk-UA");
    
    // Кольорова логіка в залежності від дії
    let actionColor = COLORS.cyan;
    if (t.action.includes("error") || t.action.includes("fatal")) actionColor = COLORS.red;
    else if (t.action.includes("success")) actionColor = COLORS.green;
    else if (t.action.includes("repair")) actionColor = COLORS.yellow;

    console.log(`${COLORS.dim}[${time}]${COLORS.reset} ${actionColor}[${t.action}]${COLORS.reset} ${t.message || ""}`);
    
    if (t.details && Object.keys(t.details).length > 0) {
       console.log(`${COLORS.dim}  -> ${JSON.stringify(t.details)}${COLORS.reset}`);
    }
  } catch(e) {
    // Якщо це не JSON, просто виводимо сирий рядок
    console.log(line);
  }
});
'
