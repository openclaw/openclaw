---
name: circadian-agent-setup
description: Complete setup for circadian self-improving AI agent (local + Colab automation). Use when user asks "setup agent circadien", "configure auto-amélioration agent", "install protocole circadien", "deploy self-evolving AI", or needs full stack installation for daily self-improvement cycle. Automates complex setup: local model, computer use, evening analysis, Colab fine-tuning automation, cron jobs.
---

# CIRCADIAN AGENT SETUP

One-command setup for self-improving AI agent with daily weight modification cycle.

## Architecture Overview

**LOCAL (Agent Computer):**
- Qwen2.5-14B (GGUF Q4_K_M) running 24/7
- Computer Use (PyAutoGUI, Playwright)
- LangGraph orchestration
- SQLite trajectory memory

**CLOUD (Google Colab Free):**
- Nightly fine-tuning (Unsloth)
- Automated via Selenium
- Checkpoint → Drive → Local sync

**CYCLE:**
- Morning (6h): Load yesterday's improved weights
- Day (7h-22h): Agent acts, logs trajectories
- Evening (22h): Auto-analysis, generate dataset
- Night (23h-4h): Colab fine-tuning automatically
- Morning (6h): Repeat with new weights

---

## ONE-COMMAND SETUP

```bash
curl -sSL https://raw.githubusercontent.com/veralume/circadian-agent/main/install.sh | bash
```

**Or manual setup:**

---

## MANUAL SETUP STEPS

### Step 1: Install Dependencies

```bash
#!/bin/bash
# install_circadian.sh

echo "Installing Circadian Agent dependencies..."

# Python packages
pip install langchain langgraph langchain-community --break-system-packages
pip install pyautogui playwright pillow --break-system-packages
pip install selenium webdriver-manager --break-system-packages
pip install schedule sqlite3 openai --break-system-packages
pip install unsloth datasets trl transformers --break-system-packages

# Playwright browsers
playwright install chromium

# llama.cpp (if not installed)
if ! command -v llama-server &> /dev/null; then
    echo "Installing llama.cpp..."
    git clone https://github.com/ggerganov/llama.cpp
    cd llama.cpp && make && cd ..
fi

echo "✓ Dependencies installed"
```

### Step 2: Create Directory Structure

```bash
mkdir -p ~/agent_circadien/{models,memory,datasets,scripts,config}
mkdir -p ~/agent_circadien/memory/{daily_logs,checkpoints}
mkdir -p ~/agent_circadien/datasets/{daily,weekly}

cd ~/agent_circadien
```

### Step 3: Download Base Model

```bash
# Download Qwen2.5-14B-Instruct Q4_K_M
wget https://huggingface.co/Qwen/Qwen2.5-14B-Instruct-GGUF/resolve/main/qwen2.5-14b-instruct-q4_k_m.gguf \
  -O models/qwen2.5-14b-instruct-q4_k_m.gguf

echo "✓ Base model downloaded"
```

### Step 4: Initialize Database

```bash
python3 << 'EOF'
import sqlite3

conn = sqlite3.connect('memory/trajectories.db')

# Trajectories table
conn.execute('''
CREATE TABLE IF NOT EXISTS trajectories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME,
    task TEXT,
    action TEXT,
    result TEXT,
    success BOOLEAN,
    screenshot_path TEXT
)
''')

# Daily analysis table
conn.execute('''
CREATE TABLE IF NOT EXISTS daily_analysis (
    date DATE PRIMARY KEY,
    total_tasks INTEGER,
    success_rate REAL,
    avg_response_time REAL,
    patterns_learned TEXT,
    dataset_path TEXT
)
''')

conn.commit()
conn.close()

print("✓ Database initialized")
EOF
```

### Step 5: Configure Google Drive + Colab

```bash
# Create Drive structure
echo "Setup Google Drive:"
echo "1. Create folder: /Agent_Circadien/"
echo "2. Inside: /datasets/, /checkpoints/, /notebooks/"
echo "3. Upload fine_tune_template.ipynb to /notebooks/"
echo ""
echo "Press Enter when done..."
read
```

### Step 6: Create Core Scripts

**Agent Main Loop:**

```python
# scripts/agent_main.py
from langraph.graph import StateGraph
import pyautogui, sqlite3, json
from datetime import datetime
from dataclasses import dataclass

@dataclass
class AgentState:
    screenshot: bytes = None
    task: str = ""
    action: dict = None
    result: str = ""
    success: bool = False

def agent_loop():
    workflow = StateGraph(AgentState)
    
    workflow.add_node("perceive", perceive_screen)
    workflow.add_node("decide", decide_action)
    workflow.add_node("act", execute_action)
    workflow.add_node("evaluate", evaluate_result)
    workflow.add_node("log", log_trajectory)
    
    workflow.add_edge("perceive", "decide")
    workflow.add_edge("decide", "act")
    workflow.add_edge("act", "evaluate")
    workflow.add_edge("evaluate", "log")
    workflow.add_edge("log", "perceive")
    
    app = workflow.compile()
    state = AgentState()
    
    while True:
        state = app.invoke(state)

if __name__ == '__main__':
    agent_loop()
```

**Evening Analysis:**

```python
# scripts/evening_analysis.py
import sqlite3, json, openai
from datetime import datetime, date

def evening_analysis():
    conn = sqlite3.connect('memory/trajectories.db')
    
    # Get today's trajectories
    today = date.today()
    trajectories = conn.execute('''
        SELECT * FROM trajectories WHERE DATE(timestamp) = ?
    ''', (today,)).fetchall()
    
    # Analyze
    dataset = generate_improvement_dataset(trajectories)
    
    # Save dataset
    dataset_path = f'datasets/daily/{today}_dataset.jsonl'
    with open(dataset_path, 'w') as f:
        for item in dataset:
            f.write(json.dumps(item) + '\n')
    
    # Log analysis
    success_rate = sum(1 for t in trajectories if t[5]) / len(trajectories)
    
    conn.execute('''
        INSERT INTO daily_analysis VALUES (?, ?, ?, ?, ?, ?)
    ''', (today, len(trajectories), success_rate, 0, '', dataset_path))
    
    conn.commit()
    print(f"✓ Evening analysis complete: {len(dataset)} training samples")

if __name__ == '__main__':
    evening_analysis()
```

**Night Training Automation:**

```python
# scripts/night_training.py
from selenium import webdriver
from selenium.webdriver.common.by import By
import time, os

def automate_colab_training():
    driver = webdriver.Chrome()
    
    # Open Colab notebook
    driver.get('https://colab.research.google.com/drive/YOUR_NOTEBOOK_ID')
    
    # Wait for load
    time.sleep(5)
    
    # Connect to runtime
    connect_button = driver.find_element(By.XPATH, "//button[contains(text(), 'Connect')]")
    connect_button.click()
    time.sleep(10)
    
    # Run all cells
    run_all = driver.find_element(By.XPATH, "//span[contains(text(), 'Run all')]")
    run_all.click()
    
    # Monitor until complete (check for "Training complete" in output)
    while True:
        time.sleep(60)
        outputs = driver.find_elements(By.CLASS_NAME, "output_area")
        if any("Training complete" in o.text for o in outputs):
            break
    
    print("✓ Training complete")
    driver.quit()

if __name__ == '__main__':
    automate_colab_training()
```

### Step 7: Setup Cron Jobs

```bash
# Add to crontab
crontab -e

# Add these lines:
0 6 * * * cd ~/agent_circadien && python scripts/morning_wake.py
0 7 * * * cd ~/agent_circadien && python scripts/agent_main.py &
0 22 * * * pkill -f agent_main.py
5 22 * * * cd ~/agent_circadien && python scripts/evening_analysis.py
0 23 * * * cd ~/agent_circadien && python scripts/night_training.py
```

### Step 8: Start Agent

```bash
# Test run
python scripts/agent_main.py

# If working, enable cron jobs
# Agent now runs autonomously!
```

---

## CONFIGURATION FILE

```yaml
# config/agent_config.yaml

agent:
  name: "CircadianAgent"
  model_path: "models/qwen2.5-14b-instruct-q4_k_m.gguf"
  llama_server_port: 8080

schedule:
  morning_wake: "06:00"
  day_start: "07:00"
  evening_analysis: "22:00"
  night_training: "23:00"

colab:
  notebook_id: "YOUR_NOTEBOOK_ID_HERE"
  drive_folder: "/Agent_Circadien"
  gpu_type: "T4"

fine_tuning:
  lora_rank: 256
  learning_rate: 2e-4
  max_steps: 100
  batch_size: 2

monitoring:
  dashboard_port: 5000
  metrics_retention_days: 90
```

---

## VALIDATION TESTS

```bash
# Test database
sqlite3 memory/trajectories.db "SELECT COUNT(*) FROM trajectories;"

# Test llama-server
curl http://localhost:8080/health

# Test Colab connection
python scripts/test_colab.py

# Test cron jobs
sudo systemctl status cron
```

---

## TROUBLESHOOTING

**Agent doesn't start:**
- Check llama-server running: `ps aux | grep llama-server`
- Check port 8080 available: `netstat -tulpn | grep 8080`

**Colab automation fails:**
- Update notebook ID in config
- Check selenium/chromedriver version
- Manually test notebook first

**Database errors:**
- Check permissions: `chmod 666 memory/trajectories.db`
- Rebuild: `python scripts/init_db.py`

---

**FIN SKILL**

Complete circadian agent setup - autonomous self-improvement in one install.
