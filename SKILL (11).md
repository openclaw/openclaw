---
name: evening-analysis-generator
description: Generate evening auto-analysis and training dataset from daily trajectories. Use when user asks "génère auto-analyse soir", "crée dataset quotidien agent", "analyse trajectoires jour", "prepare fine-tuning data", or needs to transform agent's daily actions into improvement dataset for nightly training. Core of circadian cycle - dataset quality determines improvement quality.
---

# EVENING ANALYSIS GENERATOR

Auto-analysis engine that converts daily agent trajectories into fine-tuning dataset.

## Workflow

1. **Load trajectories** — Fetch today's actions from DB
2. **Classify outcomes** — Success/failure/partial
3. **Extract lessons** — What worked, what didn't
4. **Generate dataset** — Format for fine-tuning
5. **Save + log** — Store dataset, update metrics

## Implementation

```python
def evening_analysis(date=None):
    if not date:
        date = datetime.now().date()
    
    # 1. Load trajectories
    conn = sqlite3.connect('memory/trajectories.db')
    trajectories = conn.execute(
        "SELECT * FROM trajectories WHERE DATE(timestamp) = ?",
        (date,)
    ).fetchall()
    
    if not trajectories:
        print("No trajectories for today - skipping")
        return
    
    # 2. Classify
    classified = classify_trajectories(trajectories)
    
    # 3. Extract lessons
    lessons = extract_lessons(classified)
    
    # 4. Generate dataset
    dataset = generate_training_dataset(lessons)
    
    # 5. Save
    save_dataset(dataset, date)
    log_analysis(date, classified, lessons)
    
    return dataset

def classify_trajectories(trajectories):
    """Classify each trajectory"""
    classified = {'success': [], 'failure': [], 'partial': []}
    
    for t in trajectories:
        if t['success']:
            classified['success'].append(t)
        elif 'error' in t['result'].lower():
            classified['failure'].append(t)
        else:
            classified['partial'].append(t)
    
    return classified

def extract_lessons(classified):
    """Extract what to reinforce/correct"""
    lessons = []
    
    # Successes → reinforce pattern
    for trajectory in classified['success']:
        lessons.append({
            'type': 'reinforce',
            'pattern': trajectory['action'],
            'context': trajectory['task'],
            'outcome': 'success'
        })
    
    # Failures → correction needed
    for trajectory in classified['failure']:
        lessons.append({
            'type': 'correct',
            'wrong_action': trajectory['action'],
            'context': trajectory['task'],
            'error': trajectory['result'],
            'correction': generate_correction(trajectory)
        })
    
    return lessons

def generate_training_dataset(lessons):
    """Format as instruction-following dataset"""
    dataset = []
    
    for lesson in lessons:
        if lesson['type'] == 'reinforce':
            dataset.append({
                'instruction': f"Given context: {lesson['context']}",
                'input': "What action should you take?",
                'output': lesson['pattern']
            })
        
        elif lesson['type'] == 'correct':
            dataset.append({
                'instruction': f"Given context: {lesson['context']}",
                'input': "Previous attempt failed with: {lesson['error']}. Correct approach?",
                'output': lesson['correction']
            })
    
    return dataset

def save_dataset(dataset, date):
    """Save as JSONL"""
    path = f"datasets/daily/{date}_dataset.jsonl"
    with open(path, 'w') as f:
        for item in dataset:
            f.write(json.dumps(item) + '\n')
    print(f"✓ Dataset saved: {len(dataset)} samples")
    return path
```

---

**FIN SKILL**

Evening analysis generator - daily trajectory → improvement dataset.
