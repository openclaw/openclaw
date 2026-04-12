---
name: adaptive-threshold
description: Dynamically adjust thresholds based on context, mode, or feedback. Use for "ajuste seuils dynamiquement", "adaptive sensitivity", "context-dependent threshold", "dynamic tolerance", "mode-based filtering", or any system where acceptance criteria must shift based on situation. Universal pattern for spam filters, trading systems, alert systems, quality gates, creative pipelines, anomaly detection.
---

# ADAPTIVE THRESHOLD

Universal dynamic threshold adjustment based on context signals.

## Core Pattern

```python
class AdaptiveThreshold:
    def __init__(self, base=0.7, floor=0.3, ceiling=0.95):
        """
        Args:
            base: Default threshold
            floor: Minimum allowed threshold
            ceiling: Maximum allowed threshold
        """
        self.base = base
        self.floor = floor
        self.ceiling = ceiling
        self.current = base
        self.history = []
    
    def adjust(self, context=None, mode=None, feedback=None):
        """
        Adjust threshold based on signals.
        
        Args:
            context: Dict of contextual signals
            mode: Named preset (overrides context)
            feedback: Recent pass/fail feedback for auto-tuning
            
        Returns:
            new_threshold: float
        """
        
        # Mode presets — hard switch
        if mode:
            presets = {
                'exploratory': 0.6,
                'standard': 0.7,
                'strict': 0.85,
                'critical': 0.95,
            }
            self.current = presets.get(mode, self.base)
        
        # Context modifiers — soft adjustment
        elif context:
            modifier = 0.0
            for signal, weight in context.items():
                modifier += weight  # positive = stricter, negative = looser
            self.current = self.base + modifier
        
        # Feedback auto-tuning — empirical adjustment
        elif feedback:
            self.current = self._auto_tune(feedback)
        
        # Clamp to bounds
        self.current = max(self.floor, min(self.ceiling, self.current))
        self.history.append(self.current)
        
        return self.current
    
    def _auto_tune(self, feedback):
        """
        Adjust based on false positive/negative rates.
        
        feedback: list of (score, was_correct_decision)
        """
        false_positives = sum(1 for s, c in feedback if s >= self.current and not c)
        false_negatives = sum(1 for s, c in feedback if s < self.current and c)
        total = len(feedback)
        
        fp_rate = false_positives / max(total, 1)
        fn_rate = false_negatives / max(total, 1)
        
        # Too many false positives → raise threshold
        # Too many false negatives → lower threshold
        adjustment = (fp_rate - fn_rate) * 0.1
        return self.current + adjustment
```

## Example: Alert System

```python
threshold = AdaptiveThreshold(base=0.7)

# Night shift — fewer staff, raise threshold to reduce noise
threshold.adjust(mode='strict')

# Peak hours — more capacity to handle alerts
threshold.adjust(mode='standard')

# After series of false alarms — auto-tune
feedback = [(0.75, False), (0.72, False), (0.80, True)]
threshold.adjust(feedback=feedback)  # will raise threshold
```

## Example: Content Moderation

```python
threshold = AdaptiveThreshold(base=0.7, floor=0.5, ceiling=0.95)

# Context: user is verified, topic is low-risk
threshold.adjust(context={
    'user_trust_level': -0.1,   # looser for trusted users
    'topic_sensitivity': +0.15,  # stricter for sensitive topics
})
```

## Example: Trading Signal Filter

```python
threshold = AdaptiveThreshold(base=0.6)

# High volatility → require stronger signals
threshold.adjust(context={'volatility': +0.2})

# Low volume → relax to catch opportunities
threshold.adjust(context={'volume_deficit': -0.1})
```

## Key Properties

- **Bounded**: Always clamped between floor and ceiling — no runaway
- **Three adjustment modes**: Preset switch, contextual modifier, empirical auto-tune
- **Traceable**: History of all threshold changes for audit
- **Composable**: Works with multi-axis-validator — each axis can have its own adaptive threshold

---

**FIN SKILL**
