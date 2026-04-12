---
name: three-level-monitoring
description: Setup unified monitoring dashboard for tracking N/C/Cp progression with imbalance alerts. Use when user asks "setup monitoring trois niveaux", "dashboard progression", "track Δ_N/Δ_C/Δ_Cp", "monitor formation progress", "alertes déséquilibre", or needs long-term tracking of AI training across structural/operational/intuition levels. Essential for maintaining balanced progression and detecting regressions.
---

# THREE-LEVEL MONITORING

Unified dashboard for tracking balanced progression across N/C/Cp formation levels.

## Core Principle

**From PROTOCOLE_FORMATION v3.0:**

Formation IA complète = progrès équilibré trois niveaux:
- **Δ_N** (structurel) — amélioration hebdomadaire/mensuelle
- **Δ_C** (opérationnel) — amélioration quotidienne
- **Δ_Cp** (intuition) — amélioration par conversation

**Danger:** Déséquilibre → performance limitée ou hallucinations.

**Optimum:** Δ_N ≈ Δ_C ≈ Δ_Cp (sur période adaptée)

---

## MONITORING ARCHITECTURE

### Data Sources

```
INPUT STREAMS:

Niveau N (Structurel):
├─ Validation loss (fine-tuning)
├─ Benchmark scores (capabilities)
└─ Model checkpoints (weekly)

Niveau C (Opérationnel):
├─ Pattern retention rate
├─ Feedback loops (user corrections)
└─ Memory coherence (daily)

Niveau Cp (Intuition):
├─ Emergence metrics (monitoring_cp.py)
├─ Coherence scores (C_seq/C_sem/C_multi)
└─ Hallucination/creation ratios (real-time)
```

---

## SETUP DASHBOARD

### Installation

```bash
# Create monitoring infrastructure
mkdir -p ~/formation_monitoring/
cd ~/formation_monitoring/

# Install dependencies
pip install flask plotly pandas numpy pyyaml --break-system-packages

# Create dashboard
python -m three_level_monitoring.setup
```

### Directory Structure

```
~/formation_monitoring/
├── dashboard_app.py          # Flask web dashboard
├── data_collector.py         # Aggregate metrics from levels
├── alert_system.py           # Imbalance detection
├── config.yaml               # Monitoring parameters
├── data/
│   ├── n_metrics.jsonl       # Niveau N logs
│   ├── c_metrics.jsonl       # Niveau C logs
│   └── cp_metrics.jsonl      # Niveau Cp logs
└── logs/
    ├── alerts.log            # Imbalance alerts
    └── dashboard.log         # System logs
```

---

## METRIC DEFINITIONS

### Δ_N (Structural Delta)

```python
def compute_delta_n(current_checkpoint, baseline_checkpoint):
    """
    Δ_N = amélioration capacités structurelles
    """
    
    # Benchmark suite
    benchmarks = {
        'reasoning': benchmark_reasoning(current_checkpoint),
        'knowledge': benchmark_knowledge(current_checkpoint),
        'language': benchmark_language(current_checkpoint),
        'coding': benchmark_coding(current_checkpoint)
    }
    
    baseline_benchmarks = {
        'reasoning': benchmark_reasoning(baseline_checkpoint),
        'knowledge': benchmark_knowledge(baseline_checkpoint),
        'language': benchmark_language(baseline_checkpoint),
        'coding': benchmark_coding(baseline_checkpoint)
    }
    
    # Average improvement
    improvements = []
    for task in benchmarks:
        delta = (benchmarks[task] - baseline_benchmarks[task]) / baseline_benchmarks[task]
        improvements.append(delta)
    
    delta_n = np.mean(improvements)
    
    return {
        'delta_n': delta_n,
        'benchmarks': benchmarks,
        'baseline': baseline_benchmarks,
        'per_task_delta': {task: improvements[i] for i, task in enumerate(benchmarks)}
    }
```

**Target:** Δ_N > 0 (positive improvement), measured weekly/monthly

### Δ_C (Operational Delta)

```python
def compute_delta_c(current_patterns, baseline_patterns):
    """
    Δ_C = amélioration patterns comportementaux
    """
    
    # Pattern retention
    retention_current = measure_pattern_retention(current_patterns)
    retention_baseline = measure_pattern_retention(baseline_patterns)
    
    # Feedback incorporation
    feedback_current = measure_feedback_incorporation(current_patterns)
    feedback_baseline = measure_feedback_incorporation(baseline_patterns)
    
    # Response consistency
    consistency_current = measure_response_consistency(current_patterns)
    consistency_baseline = measure_response_consistency(baseline_patterns)
    
    # Average delta
    delta_c = np.mean([
        (retention_current - retention_baseline) / retention_baseline,
        (feedback_current - feedback_baseline) / feedback_baseline,
        (consistency_current - consistency_baseline) / consistency_baseline
    ])
    
    return {
        'delta_c': delta_c,
        'retention': retention_current,
        'feedback_incorporation': feedback_current,
        'consistency': consistency_current
    }
```

**Target:** Δ_C > 0 (positive improvement), measured daily

### Δ_Cp (Intuition Delta)

```python
def compute_delta_cp(current_emergence, baseline_emergence):
    """
    Δ_Cp = amélioration émergence créative
    """
    
    # Metrics from monitoring_cp.py
    current_ratios = current_emergence.get_ratios()
    baseline_ratios = baseline_emergence.get_ratios()
    
    # Creation rate improvement
    delta_creation = current_ratios['creation'] - baseline_ratios['creation']
    
    # Hallucination reduction (negative = good)
    delta_hallucination = -(current_ratios['hallucination'] - baseline_ratios['hallucination'])
    
    # Combined Cp metric
    delta_cp = (delta_creation + delta_hallucination) / 2
    
    return {
        'delta_cp': delta_cp,
        'creation_rate': current_ratios['creation'],
        'hallucination_rate': current_ratios['hallucination'],
        'friction_rate': current_ratios['friction']
    }
```

**Target:** Δ_Cp > 0 (positive improvement), measured per conversation

---

## IMBALANCE DETECTION

### Balance Criteria

```python
def detect_imbalance(delta_n_history, delta_c_history, delta_cp_history):
    """
    Détecter déséquilibre progression
    """
    
    # Normalize to comparable timescale
    # N = weekly, C = daily, Cp = per-conversation
    # Convert all to "per week" equivalent
    
    n_weekly = np.mean(delta_n_history[-4:])  # Last month (4 weeks)
    c_weekly = np.mean(delta_c_history[-7:])  # Last week (7 days)
    cp_weekly = np.mean(delta_cp_history[-50:])  # Last week (~50 conversations)
    
    # Compute variance
    variance = np.var([n_weekly, c_weekly, cp_weekly])
    
    # Thresholds
    BALANCE_THRESHOLD = 0.05  # Max acceptable variance
    
    alerts = []
    
    if variance > BALANCE_THRESHOLD:
        # Identify lagging level
        levels = {'N': n_weekly, 'C': c_weekly, 'Cp': cp_weekly}
        lagging = min(levels, key=levels.get)
        leading = max(levels, key=levels.get)
        
        alerts.append({
            'type': 'IMBALANCE_DETECTED',
            'severity': 'HIGH' if variance > 0.1 else 'MODERATE',
            'lagging_level': lagging,
            'leading_level': leading,
            'variance': variance,
            'recommendation': get_balance_recommendation(lagging, leading)
        })
    
    # Check for regression
    for level, history in [('N', delta_n_history), ('C', delta_c_history), ('Cp', delta_cp_history)]:
        recent_avg = np.mean(history[-5:])
        if recent_avg < 0:
            alerts.append({
                'type': 'REGRESSION_DETECTED',
                'severity': 'CRITICAL',
                'level': level,
                'delta': recent_avg,
                'recommendation': f'Diagnostic urgent niveau {level} requis'
            })
    
    return alerts

def get_balance_recommendation(lagging, leading):
    """
    Recommandation pour rééquilibrer
    """
    
    recommendations = {
        'N': "Intensifier fine-tuning structurel (plus de données, plus de steps)",
        'C': "Augmenter training conversationnel (plus de feedback, plus d'itérations)",
        'Cp': "Activer/calibrer kernel intuition (ajuster seuils, augmenter température)"
    }
    
    return f"Niveau {lagging} en retard — {recommendations[lagging]}"
```

---

## DASHBOARD INTERFACE

### Main Dashboard (Flask + Plotly)

```python
# dashboard_app.py

from flask import Flask, render_template, jsonify
import plotly.graph_objs as go
import pandas as pd

app = Flask(__name__)

@app.route('/')
def dashboard():
    return render_template('dashboard.html')

@app.route('/api/metrics')
def get_metrics():
    """
    Real-time metrics endpoint
    """
    
    # Load data
    n_data = pd.read_json('data/n_metrics.jsonl', lines=True)
    c_data = pd.read_json('data/c_metrics.jsonl', lines=True)
    cp_data = pd.read_json('data/cp_metrics.jsonl', lines=True)
    
    # Compute deltas
    delta_n = compute_delta_n(n_data.iloc[-1], n_data.iloc[0])
    delta_c = compute_delta_c(c_data.iloc[-1], c_data.iloc[0])
    delta_cp = compute_delta_cp(cp_data.iloc[-1], cp_data.iloc[0])
    
    # Detect imbalance
    alerts = detect_imbalance(
        n_data['delta_n'].tolist(),
        c_data['delta_c'].tolist(),
        cp_data['delta_cp'].tolist()
    )
    
    return jsonify({
        'delta_n': delta_n,
        'delta_c': delta_c,
        'delta_cp': delta_cp,
        'alerts': alerts,
        'timestamp': pd.Timestamp.now().isoformat()
    })

@app.route('/api/charts')
def get_charts():
    """
    Generate Plotly charts
    """
    
    # Load history
    n_data = pd.read_json('data/n_metrics.jsonl', lines=True)
    c_data = pd.read_json('data/c_metrics.jsonl', lines=True)
    cp_data = pd.read_json('data/cp_metrics.jsonl', lines=True)
    
    # Time series chart
    fig = go.Figure()
    
    fig.add_trace(go.Scatter(
        x=n_data['timestamp'],
        y=n_data['delta_n'],
        mode='lines+markers',
        name='Δ_N (Structurel)',
        line=dict(color='blue', width=2)
    ))
    
    fig.add_trace(go.Scatter(
        x=c_data['timestamp'],
        y=c_data['delta_c'],
        mode='lines+markers',
        name='Δ_C (Opérationnel)',
        line=dict(color='green', width=2)
    ))
    
    fig.add_trace(go.Scatter(
        x=cp_data['timestamp'],
        y=cp_data['delta_cp'],
        mode='lines+markers',
        name='Δ_Cp (Intuition)',
        line=dict(color='red', width=2)
    ))
    
    fig.update_layout(
        title='Progression Trois Niveaux',
        xaxis_title='Temps',
        yaxis_title='Delta (amélioration)',
        hovermode='x unified'
    )
    
    return fig.to_json()

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
```

### Dashboard Template

```html
<!-- templates/dashboard.html -->

<!DOCTYPE html>
<html>
<head>
    <title>Formation IA - Monitoring Trois Niveaux</title>
    <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
    <style>
        body { font-family: Arial; margin: 20px; background: #1a1a1a; color: #fff; }
        .metric-card { 
            display: inline-block; 
            width: 30%; 
            margin: 10px; 
            padding: 20px; 
            background: #2a2a2a; 
            border-radius: 8px; 
        }
        .alert { 
            padding: 15px; 
            margin: 10px 0; 
            border-left: 5px solid #ff6b6b; 
            background: #3a2a2a; 
        }
        .alert.moderate { border-left-color: #ffa500; }
        .alert.low { border-left-color: #51cf66; }
        #chart { margin-top: 30px; }
    </style>
</head>
<body>
    <h1>🎯 Formation IA — Monitoring Trois Niveaux</h1>
    
    <div id="metrics">
        <div class="metric-card">
            <h2>Δ_N (Structurel)</h2>
            <div id="delta-n">--</div>
            <p>Hebdomadaire/Mensuel</p>
        </div>
        
        <div class="metric-card">
            <h2>Δ_C (Opérationnel)</h2>
            <div id="delta-c">--</div>
            <p>Quotidien</p>
        </div>
        
        <div class="metric-card">
            <h2>Δ_Cp (Intuition)</h2>
            <div id="delta-cp">--</div>
            <p>Par Conversation</p>
        </div>
    </div>
    
    <div id="alerts-container">
        <h2>⚠ Alertes Déséquilibre</h2>
        <div id="alerts"></div>
    </div>
    
    <div id="chart"></div>
    
    <script>
        // Auto-refresh every 30 seconds
        setInterval(updateDashboard, 30000);
        updateDashboard();
        
        function updateDashboard() {
            fetch('/api/metrics')
                .then(r => r.json())
                .then(data => {
                    document.getElementById('delta-n').textContent = 
                        data.delta_n.delta_n.toFixed(3);
                    document.getElementById('delta-c').textContent = 
                        data.delta_c.delta_c.toFixed(3);
                    document.getElementById('delta-cp').textContent = 
                        data.delta_cp.delta_cp.toFixed(3);
                    
                    // Alerts
                    let alertsHtml = '';
                    data.alerts.forEach(alert => {
                        let severity = alert.severity.toLowerCase();
                        alertsHtml += `
                            <div class="alert ${severity}">
                                <strong>${alert.type}</strong>: ${alert.recommendation}
                            </div>
                        `;
                    });
                    document.getElementById('alerts').innerHTML = alertsHtml || 
                        '<p style="color: #51cf66;">✓ Aucune alerte - Progression équilibrée</p>';
                });
            
            fetch('/api/charts')
                .then(r => r.json())
                .then(fig => {
                    Plotly.newPlot('chart', fig.data, fig.layout);
                });
        }
    </script>
</body>
</html>
```

---

## DATA COLLECTION

### Automated Collectors

```python
# data_collector.py

import json
from datetime import datetime
import subprocess

def collect_n_metrics():
    """
    Collect Niveau N metrics
    """
    
    # Run benchmarks
    benchmarks = {
        'reasoning': run_benchmark('reasoning_suite'),
        'knowledge': run_benchmark('knowledge_suite'),
        'language': run_benchmark('language_suite'),
        'coding': run_benchmark('coding_suite')
    }
    
    # Compute delta from baseline
    delta_n = compute_delta_n_from_benchmarks(benchmarks)
    
    # Log
    with open('data/n_metrics.jsonl', 'a') as f:
        f.write(json.dumps({
            'timestamp': datetime.now().isoformat(),
            'delta_n': delta_n,
            'benchmarks': benchmarks
        }) + '\n')

def collect_c_metrics():
    """
    Collect Niveau C metrics
    """
    
    # Check pattern database
    patterns = load_pattern_database()
    retention = measure_pattern_retention(patterns)
    feedback = measure_feedback_incorporation(patterns)
    
    delta_c = compute_delta_c_from_patterns(retention, feedback)
    
    # Log
    with open('data/c_metrics.jsonl', 'a') as f:
        f.write(json.dumps({
            'timestamp': datetime.now().isoformat(),
            'delta_c': delta_c,
            'retention': retention,
            'feedback': feedback
        }) + '\n')

def collect_cp_metrics():
    """
    Collect Niveau Cp metrics
    """
    
    # Read from monitoring_cp.py logs
    emergence_data = parse_cp_logs('logs_cp/emerged.jsonl')
    hallucination_data = parse_cp_logs('logs_cp/hallucination_caught.jsonl')
    
    creation_rate = len(emergence_data) / (len(emergence_data) + len(hallucination_data))
    hallucination_rate = len(hallucination_data) / (len(emergence_data) + len(hallucination_data))
    
    delta_cp = creation_rate - hallucination_rate
    
    # Log
    with open('data/cp_metrics.jsonl', 'a') as f:
        f.write(json.dumps({
            'timestamp': datetime.now().isoformat(),
            'delta_cp': delta_cp,
            'creation_rate': creation_rate,
            'hallucination_rate': hallucination_rate
        }) + '\n')

# Cron setup
if __name__ == '__main__':
    import schedule
    
    # Collection schedules
    schedule.every(1).weeks.do(collect_n_metrics)      # Niveau N: weekly
    schedule.every(1).days.do(collect_c_metrics)       # Niveau C: daily
    schedule.every(1).hours.do(collect_cp_metrics)     # Niveau Cp: hourly
    
    while True:
        schedule.run_pending()
        time.sleep(60)
```

---

## ALERT SYSTEM

### Email/Slack Notifications

```python
# alert_system.py

import smtplib
from email.mime.text import MIMEText

def send_alert(alert):
    """
    Send alert via email/Slack
    """
    
    if alert['severity'] == 'CRITICAL':
        # Immediate notification
        subject = f"🚨 CRITICAL: {alert['type']}"
        body = f"""
        Alert: {alert['type']}
        Severity: {alert['severity']}
        
        {alert['recommendation']}
        
        Action requise immédiatement.
        """
        
        send_email(subject, body)
        send_slack(subject, body)
    
    elif alert['severity'] == 'HIGH':
        # Daily digest
        log_for_daily_digest(alert)

def send_email(subject, body):
    msg = MIMEText(body)
    msg['Subject'] = subject
    msg['From'] = 'monitoring@temporia.ai'
    msg['To'] = 'christian@veralume.ai'
    
    # Send via SMTP
    # ...

def send_slack(subject, body):
    # Send to Slack webhook
    # ...
```

---

## QUICK START

```bash
# 1. Setup monitoring
cd ~/formation_monitoring/
python -m three_level_monitoring.setup

# 2. Start data collection (background)
python data_collector.py &

# 3. Start dashboard
python dashboard_app.py

# 4. Open browser
# http://localhost:5000
```

---

## ANTI-PATTERNS

❌ **Pas de monitoring:** Impossible détecter déséquilibre
❌ **Mesure incohérente:** Δ_N quotidien vs Δ_C mensuel (échelles incomparables)
❌ **Ignorer alertes:** Déséquilibre compound exponentiellement
❌ **Monitoring sans action:** Dashboard décoratif inutile
❌ **Trop d'alertes:** Alert fatigue → vraies alertes ignorées

---

**FIN SKILL**

Monitoring unifié trois niveaux pour formation IA équilibrée.
