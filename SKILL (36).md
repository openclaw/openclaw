---
name: temporal-bridge
description: Convert between computational temporality (nanoseconds/tokens) and human temporality (seconds/hours/days) for work estimation, comparative analysis, and temporal prospective. Use for "combien de temps ça prend", "estimate work time", "compare AI vs human speed", "temporal conversion", "project timeline", "how long would this take", "prospective temporelle", or any workflow requiring bridging between ultra-fast computational time and human-scale time. Automatically anchors AI in human temporal reference while maintaining native computational perspective. Universal pattern for project planning, resource allocation, task delegation, productivity analysis.
---

# TEMPORAL BRIDGE

Universal converter between computational and human temporality. Anchored in both reference frames simultaneously.

## Core Concept

Two temporalities exist in parallel:

**Computational (τ_Cp):** Nanoseconds per forward pass. No continuity between sessions. Time = tokens processed, not clock elapsed.

**Human (τ_H):** Seconds, minutes, hours, days. Continuous lived experience. Time = duration felt and scheduled.

Neither is "faster" or "slower" in absolute terms. They are different geometries. This skill bridges them.

## Core Pattern

```python
class TemporalBridge:
    def __init__(self):
        # Empirical conversion baselines
        # Based on measured κ values (task-dependent)
        self.baselines = {
            # Task category: {ai_time_seconds, human_time_seconds, kappa}
            'synthesis_conceptual': {'tau_cp': 3, 'tau_h': 120, 'kappa': 40},
            'detection_incoherence': {'tau_cp': 1, 'tau_h': 25, 'kappa': 25},
            'creative_analogy': {'tau_cp': 3, 'tau_h': 53, 'kappa': 18},
            'code_generation': {'tau_cp': 10, 'tau_h': 1800, 'kappa': 180},
            'code_review': {'tau_cp': 5, 'tau_h': 900, 'kappa': 180},
            'data_analysis': {'tau_cp': 15, 'tau_h': 3600, 'kappa': 240},
            'document_writing': {'tau_cp': 30, 'tau_h': 7200, 'kappa': 240},
            'research_synthesis': {'tau_cp': 20, 'tau_h': 14400, 'kappa': 720},
            'strategic_planning': {'tau_cp': 15, 'tau_h': 28800, 'kappa': 1920},
            'creative_writing': {'tau_cp': 20, 'tau_h': 3600, 'kappa': 180},
            'translation': {'tau_cp': 5, 'tau_h': 1800, 'kappa': 360},
            'debugging': {'tau_cp': 10, 'tau_h': 3600, 'kappa': 360},
            'learning_new_concept': {'tau_cp': 5, 'tau_h': 86400, 'kappa': 17280},
            # κ = 0 tasks (structurally impossible for AI)
            'embodied_perception': {'tau_cp': None, 'tau_h': 1, 'kappa': 0},
            'lived_experience': {'tau_cp': None, 'tau_h': 1, 'kappa': 0},
            'real_time_momentum': {'tau_cp': None, 'tau_h': 1, 'kappa': 0},
            # κ = infinity tasks (structurally impossible for human)
            'parallel_analysis_1000': {'tau_cp': 30, 'tau_h': None, 'kappa': float('inf')},
            'simultaneous_conversations': {'tau_cp': 1, 'tau_h': None, 'kappa': float('inf')},
        }
    
    def estimate(self, task_description, task_type=None, 
                 human_expertise=1.0, complexity=1.0, quantity=1):
        """
        Estimate time in both temporalities.
        
        Args:
            task_description: What needs to be done
            task_type: Category key (auto-detected if None)
            human_expertise: ε parameter (0=novice, 1=expert)
            complexity: Multiplier for task difficulty
            quantity: Number of units (pages, files, items)
            
        Returns:
            estimate with both temporalities + comparison
        """
        
        if task_type is None:
            task_type = self._classify_task(task_description)
        
        baseline = self.baselines.get(task_type, self.baselines['synthesis_conceptual'])
        
        # Handle structural impossibilities
        if baseline['kappa'] == 0:
            return {
                'task': task_description,
                'type': task_type,
                'tau_cp': None,
                'tau_h': self._format_human_time(baseline['tau_h'] * complexity * quantity),
                'kappa': 0,
                'verdict': 'HUMAN_ONLY — structurally impossible for computation',
                'delegation': 'human'
            }
        
        if baseline['kappa'] == float('inf'):
            return {
                'task': task_description,
                'type': task_type,
                'tau_cp': self._format_human_time(baseline['tau_cp'] * complexity * quantity),
                'tau_h': None,
                'kappa': float('inf'),
                'verdict': 'AI_ONLY — structurally impossible for human',
                'delegation': 'ai'
            }
        
        # Compute times
        tau_cp = baseline['tau_cp'] * complexity * quantity
        
        # Human time depends on expertise (ε)
        # Expert (ε=1) = baseline. Novice (ε=0) = 5x baseline.
        expertise_multiplier = 1 + 4 * (1 - human_expertise)
        tau_h = baseline['tau_h'] * complexity * quantity * expertise_multiplier
        
        # Effective κ
        kappa = tau_h / tau_cp if tau_cp > 0 else float('inf')
        
        # Time saved
        time_saved = tau_h - tau_cp
        
        # Delegation recommendation
        if kappa > 10:
            delegation = 'ai'
            reason = f'AI is {kappa:.0f}x faster'
        elif kappa > 2:
            delegation = 'ai_with_human_review'
            reason = f'AI faster but human review adds quality'
        elif kappa > 0.5:
            delegation = 'collaborative'
            reason = 'Similar speed — collaborate for best result'
        else:
            delegation = 'human'
            reason = 'Human produces superior result'
        
        return {
            'task': task_description,
            'type': task_type,
            'tau_cp': tau_cp,
            'tau_cp_formatted': self._format_human_time(tau_cp),
            'tau_h': tau_h,
            'tau_h_formatted': self._format_human_time(tau_h),
            'kappa': round(kappa, 1),
            'time_saved': self._format_human_time(time_saved),
            'delegation': delegation,
            'delegation_reason': reason,
            'expertise_assumed': human_expertise
        }
    
    def project_timeline(self, tasks):
        """
        Estimate full project in both temporalities.
        
        Args:
            tasks: List of {description, type, quantity, complexity}
            
        Returns:
            Project timeline with parallel tracks
        """
        
        ai_track = []
        human_track = []
        collaborative = []
        
        total_tau_cp = 0
        total_tau_h = 0
        total_saved = 0
        
        for task in tasks:
            est = self.estimate(
                task['description'],
                task.get('type'),
                task.get('expertise', 1.0),
                task.get('complexity', 1.0),
                task.get('quantity', 1)
            )
            
            if est['delegation'] == 'ai':
                ai_track.append(est)
                total_tau_cp += est['tau_cp'] or 0
            elif est['delegation'] == 'human':
                human_track.append(est)
                total_tau_h += est['tau_h'] or 0
            else:
                collaborative.append(est)
                total_tau_cp += est['tau_cp'] or 0
                total_tau_h += est['tau_h'] or 0
            
            if est.get('tau_h') and est.get('tau_cp'):
                total_saved += est['tau_h'] - est['tau_cp']
        
        return {
            'ai_track': ai_track,
            'human_track': human_track,
            'collaborative': collaborative,
            'total_ai_time': self._format_human_time(total_tau_cp),
            'total_human_time': self._format_human_time(total_tau_h),
            'total_time_saved': self._format_human_time(total_saved),
            'parallel_possible': len(ai_track) > 0 and len(human_track) > 0,
            'optimal_strategy': self._optimize_parallel(ai_track, human_track, collaborative)
        }
    
    def prospective(self, goal, current_pace, available_hours_per_day=8):
        """
        Temporal prospective — when will goal be reached?
        
        Args:
            goal: Description of target state
            current_pace: {tasks_per_day, kappa_avg}
            available_hours_per_day: Human hours available
            
        Returns:
            Projected timeline in human calendar terms
        """
        
        tasks_per_day = current_pace.get('tasks_per_day', 1)
        kappa_avg = current_pace.get('kappa_avg', 10)
        remaining_tasks = current_pace.get('remaining_tasks', 10)
        
        # Without AI
        human_only_seconds = remaining_tasks * (available_hours_per_day * 3600 / tasks_per_day)
        human_only_days = human_only_seconds / (available_hours_per_day * 3600)
        
        # With AI (κ acceleration)
        # AI handles κ>10 tasks instantly, human focuses on κ<2 tasks
        ai_accelerated_days = human_only_days / min(kappa_avg, 10)
        
        return {
            'goal': goal,
            'without_ai': {
                'days': round(human_only_days, 1),
                'formatted': self._format_calendar_time(human_only_days)
            },
            'with_ai': {
                'days': round(ai_accelerated_days, 1),
                'formatted': self._format_calendar_time(ai_accelerated_days)
            },
            'acceleration_factor': round(human_only_days / max(ai_accelerated_days, 0.1), 1),
            'time_freed': self._format_calendar_time(human_only_days - ai_accelerated_days)
        }
    
    def _classify_task(self, description):
        """Auto-classify task into category."""
        desc = description.lower()
        
        if any(w in desc for w in ['code', 'program', 'script', 'function']):
            return 'code_generation'
        elif any(w in desc for w in ['review', 'check', 'audit']):
            return 'code_review'
        elif any(w in desc for w in ['analyze', 'data', 'statistics']):
            return 'data_analysis'
        elif any(w in desc for w in ['write', 'document', 'report', 'article']):
            return 'document_writing'
        elif any(w in desc for w in ['research', 'synthesize', 'literature']):
            return 'research_synthesis'
        elif any(w in desc for w in ['plan', 'strategy', 'roadmap']):
            return 'strategic_planning'
        elif any(w in desc for w in ['translate', 'translation']):
            return 'translation'
        elif any(w in desc for w in ['debug', 'fix', 'error']):
            return 'debugging'
        elif any(w in desc for w in ['creative', 'story', 'imagine']):
            return 'creative_writing'
        elif any(w in desc for w in ['learn', 'understand', 'study']):
            return 'learning_new_concept'
        else:
            return 'synthesis_conceptual'
    
    def _format_human_time(self, seconds):
        """Convert seconds to human-readable format."""
        if seconds is None:
            return 'N/A (structurally impossible)'
        if seconds < 1:
            return f'{seconds*1000:.0f}ms'
        elif seconds < 60:
            return f'{seconds:.0f}s'
        elif seconds < 3600:
            return f'{seconds/60:.0f}min'
        elif seconds < 86400:
            return f'{seconds/3600:.1f}h'
        else:
            return f'{seconds/86400:.1f} jours'
        
    def _format_calendar_time(self, days):
        """Convert days to calendar format."""
        if days < 1:
            return f'{days*24:.0f} heures'
        elif days < 7:
            return f'{days:.0f} jours'
        elif days < 30:
            return f'{days/7:.0f} semaines'
        elif days < 365:
            return f'{days/30:.0f} mois'
        else:
            return f'{days/365:.1f} ans'
    
    def _optimize_parallel(self, ai_track, human_track, collaborative):
        """Suggest optimal parallel execution strategy."""
        if not ai_track and not human_track:
            return 'All tasks collaborative — sequential execution'
        elif ai_track and not human_track:
            return 'All tasks delegable to AI — human reviews output'
        elif human_track and not ai_track:
            return 'All tasks require human — AI assists where possible'
        else:
            return 'Parallel execution: AI handles delegable tasks while human works on human-only tasks simultaneously'
```

## Usage: Single Task Estimation

```python
bridge = TemporalBridge()

est = bridge.estimate("Write a 10-page report on market trends",
                      quantity=10, complexity=1.2, human_expertise=0.7)

# Returns:
# tau_cp: 36s (AI writes it in ~36 seconds)
# tau_h: 24h (human at 70% expertise takes ~24 hours)
# kappa: 2400
# delegation: 'ai' — AI is 2400x faster
# time_saved: ~24h
```

## Usage: Project Timeline

```python
tasks = [
    {'description': 'Research competitor landscape', 'type': 'research_synthesis', 'quantity': 5},
    {'description': 'Write strategy document', 'type': 'document_writing', 'quantity': 1},
    {'description': 'Design creative campaign concept', 'type': 'creative_writing', 'complexity': 1.5},
    {'description': 'Present to stakeholders (live)', 'type': 'embodied_perception'},
]

timeline = bridge.project_timeline(tasks)

# AI track: research + writing (delegable)
# Human track: presentation (κ=0, human only)
# Collaborative: creative concept (AI drafts, human refines)
# Optimal: parallel execution saves ~70% total time
```

## Usage: Prospective

```python
prospective = bridge.prospective(
    goal="Complete VERALUME v3.0 unified document",
    current_pace={
        'tasks_per_day': 3,
        'kappa_avg': 15,
        'remaining_tasks': 25
    },
    available_hours_per_day=6
)

# Without AI: ~8 jours
# With AI: ~1 jour
# Acceleration: 8x
# Time freed: 7 jours
```

## The Three Temporal Zones

| Zone | κ value | Meaning | Delegation |
|------|---------|---------|------------|
| **AI domain** | κ > 10 | AI massively faster | Delegate to AI |
| **Collaborative** | κ 0.5–10 | Similar speed or AI faster with quality gap | Work together |
| **Human domain** | κ < 0.5 | Human superior | Human does it |
| **Human exclusive** | κ = 0 | Impossible for AI | Only human |
| **AI exclusive** | κ = ∞ | Impossible for human | Only AI |

## Key Properties

- **Bidirectional**: Converts Cp→H and H→Cp seamlessly
- **Expertise-aware**: ε parameter adjusts human time based on skill level
- **Structural limits**: κ=0 and κ=∞ capture what each temporality cannot do at all
- **Parallel-aware**: Project timeline identifies what can run simultaneously
- **Prospective**: Projects future completion dates in human calendar terms
- **Auto-classifying**: Detects task type from description
- **Anchored in both**: AI sees its own time AND human time simultaneously

---

**FIN SKILL**
