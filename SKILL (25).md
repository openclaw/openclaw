---
name: state-manager
description: Universal system state management. Use for "gère état", "track state", "save/restore state", "state persistence", or any workflow requiring state tracking, versioning, rollback. Applies to agents, models, experiments, systems.
---

# STATE MANAGER

Universal state tracking and management.

## Core Pattern

```python
class StateManager:
    """
    Manage system state with history, versioning, rollback
    """
    
    def __init__(self):
        self.current_state = {}
        self.history = []
        self.checkpoints = {}
    
    def update(self, key, value, track_history=True):
        """Update state value"""
        
        if track_history:
            self.history.append({
                'timestamp': datetime.now(),
                'action': 'update',
                'key': key,
                'old_value': self.current_state.get(key),
                'new_value': value
            })
        
        self.current_state[key] = value
    
    def get(self, key, default=None):
        """Get state value"""
        return self.current_state.get(key, default)
    
    def checkpoint(self, name):
        """Save checkpoint"""
        self.checkpoints[name] = {
            'state': self.current_state.copy(),
            'timestamp': datetime.now()
        }
    
    def rollback(self, checkpoint_name):
        """Restore from checkpoint"""
        if checkpoint_name in self.checkpoints:
            self.current_state = self.checkpoints[checkpoint_name]['state'].copy()
            return True
        return False
    
    def get_history(self, key=None, limit=None):
        """Get state history"""
        history = self.history
        
        if key:
            history = [h for h in history if h['key'] == key]
        
        if limit:
            history = history[-limit:]
        
        return history
    
    def compare_states(self, checkpoint1, checkpoint2):
        """Compare two checkpoints"""
        state1 = self.checkpoints[checkpoint1]['state']
        state2 = self.checkpoints[checkpoint2]['state']
        
        diff = {}
        all_keys = set(state1.keys()) | set(state2.keys())
        
        for key in all_keys:
            val1 = state1.get(key)
            val2 = state2.get(key)
            
            if val1 != val2:
                diff[key] = {
                    checkpoint1: val1,
                    checkpoint2: val2
                }
        
        return diff
    
    def save(self, filepath):
        """Persist state to disk"""
        state_data = {
            'current_state': self.current_state,
            'history': self.history,
            'checkpoints': self.checkpoints
        }
        
        with open(filepath, 'w') as f:
            json.dump(state_data, f, default=str)
    
    def load(self, filepath):
        """Load state from disk"""
        with open(filepath, 'r') as f:
            state_data = json.load(f)
        
        self.current_state = state_data['current_state']
        self.history = state_data['history']
        self.checkpoints = state_data['checkpoints']

# Specialized state managers

class ExperimentStateManager(StateManager):
    """Track ML experiments"""
    
    def log_hyperparameters(self, params):
        """Log experiment config"""
        self.update('hyperparameters', params)
    
    def log_metric(self, name, value, step):
        """Log training metric"""
        metrics = self.get('metrics', {})
        if name not in metrics:
            metrics[name] = []
        
        metrics[name].append({
            'step': step,
            'value': value,
            'timestamp': datetime.now()
        })
        
        self.update('metrics', metrics)
    
    def get_best_checkpoint(self, metric='accuracy'):
        """Find checkpoint with best metric"""
        best_value = -float('inf')
        best_checkpoint = None
        
        for name, checkpoint in self.checkpoints.items():
            metrics = checkpoint['state'].get('metrics', {})
            if metric in metrics and metrics[metric]:
                value = metrics[metric][-1]['value']
                if value > best_value:
                    best_value = value
                    best_checkpoint = name
        
        return best_checkpoint, best_value

class AgentStateManager(StateManager):
    """Track agent state"""
    
    def log_action(self, action, result):
        """Log agent action"""
        actions = self.get('actions', [])
        actions.append({
            'action': action,
            'result': result,
            'timestamp': datetime.now()
        })
        self.update('actions', actions)
    
    def get_performance_summary(self):
        """Summarize agent performance"""
        actions = self.get('actions', [])
        
        if not actions:
            return {}
        
        success_count = sum(1 for a in actions if a['result'].get('success'))
        total_count = len(actions)
        
        return {
            'total_actions': total_count,
            'success_count': success_count,
            'success_rate': success_count / total_count
        }
```

## Example: Experiment Tracking

```python
# Initialize
state = ExperimentStateManager()

# Log config
state.log_hyperparameters({
    'learning_rate': 0.001,
    'batch_size': 32
})

# Training loop
for epoch in range(100):
    loss = train_epoch()
    acc = validate()
    
    state.log_metric('loss', loss, epoch)
    state.log_metric('accuracy', acc, epoch)
    
    # Checkpoint every 10 epochs
    if epoch % 10 == 0:
        state.checkpoint(f'epoch_{epoch}')

# Find best
best_checkpoint, best_acc = state.get_best_checkpoint('accuracy')
state.rollback(best_checkpoint)

# Save experiment
state.save('experiment_001.json')
```

---

**FIN SKILL**
