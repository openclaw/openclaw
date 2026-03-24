---
name: operating-point-regulator
description: Maintain a system in its optimal operating zone between rigidity and chaos. Use for "maintiens zone optimale", "edge of chaos", "homeostasis", "keep in range", "regulate operating point", "rebalance", "prevent drift", "thermostat logic", or any system that must stay in a sweet spot between too rigid and too volatile. Universal pattern for portfolio rebalancing, process control, team management, model training, temperature regulation, criticality maintenance.
---

# OPERATING POINT REGULATOR

Universal dynamic regulation to keep a system in its productive zone.

## Core Pattern

```python
class OperatingPointRegulator:
    def __init__(self, target_zone, measure_fn, actuators):
        """
        Args:
            target_zone: (low, high) — the productive band
            measure_fn: callable(system) → current_value
            actuators: dict of {
                'increase': callable(system, magnitude),
                'decrease': callable(system, magnitude)
            }
        """
        self.low = target_zone[0]
        self.high = target_zone[1]
        self.target = (self.low + self.high) / 2
        self.measure = measure_fn
        self.actuators = actuators
        self.history = []
    
    def regulate(self, system, gain=0.1):
        """
        Measure system state, apply correction if outside zone.
        
        Args:
            system: the system to regulate
            gain: correction magnitude (0-1). Low = gentle, High = aggressive.
            
        Returns:
            state: current measurement
            action: what was done
            zone_status: 'in_zone', 'too_low', 'too_high'
        """
        current = self.measure(system)
        self.history.append(current)
        
        if current < self.low:
            # Too rigid / cold / conservative
            error = self.low - current
            magnitude = error * gain
            self.actuators['increase'](system, magnitude)
            return current, 'increase', 'too_low'
        
        elif current > self.high:
            # Too chaotic / hot / volatile
            error = current - self.high
            magnitude = error * gain
            self.actuators['decrease'](system, magnitude)
            return current, 'decrease', 'too_high'
        
        else:
            # In the zone — do nothing
            return current, 'hold', 'in_zone'
    
    def diagnose(self):
        """Analyze regulation history."""
        if len(self.history) < 10:
            return {'status': 'insufficient_data'}
        
        recent = self.history[-20:]
        return {
            'mean': np.mean(recent),
            'variance': np.var(recent),
            'in_zone_pct': sum(1 for v in recent 
                              if self.low <= v <= self.high) / len(recent),
            'trend': 'rising' if recent[-1] > recent[0] else 'falling',
            'oscillating': is_oscillating(recent),
            'drifting': abs(np.mean(recent[-5:]) - np.mean(recent[:5])) > 
                        (self.high - self.low) * 0.5
        }
```

## Why This Is Different From Adaptive Threshold

- **adaptive-threshold**: Adjusts a gate/filter pass criteria. Binary: pass or reject.
- **operating-point-regulator**: Maintains a continuous system state in a band. Measures, corrects, holds.

One decides what gets through. The other keeps the whole system in its productive zone.

## Example: Model Training Temperature

```python
regulator = OperatingPointRegulator(
    target_zone=(0.7, 1.3),  # temperature sweet spot
    measure_fn=lambda model: model.effective_temperature(),
    actuators={
        'increase': lambda m, mag: m.set_temperature(m.temp + mag),
        'decrease': lambda m, mag: m.set_temperature(m.temp - mag),
    }
)

for epoch in training:
    state, action, status = regulator.regulate(model, gain=0.05)
    # Keeps model at edge of chaos — not frozen, not exploding
```

## Example: Portfolio Rebalancing

```python
regulator = OperatingPointRegulator(
    target_zone=(0.55, 0.65),  # target equity allocation 55-65%
    measure_fn=lambda p: p.equity_ratio(),
    actuators={
        'increase': lambda p, mag: p.buy_equity(mag),
        'decrease': lambda p, mag: p.sell_equity(mag),
    }
)

# Monthly check
state, action, status = regulator.regulate(portfolio, gain=0.3)
```

## Example: Team Workload Balance

```python
regulator = OperatingPointRegulator(
    target_zone=(0.6, 0.8),  # utilization sweet spot
    measure_fn=lambda team: team.avg_utilization(),
    actuators={
        'increase': lambda t, mag: t.assign_more_work(mag),
        'decrease': lambda t, mag: t.redistribute_or_defer(mag),
    }
)

# Too low = team is idle, too high = burnout risk
state, action, status = regulator.regulate(team)
```

## Example: Process Control (Thermostat Pattern)

```python
regulator = OperatingPointRegulator(
    target_zone=(20.0, 22.0),  # degrees celsius
    measure_fn=lambda room: room.temperature(),
    actuators={
        'increase': lambda r, mag: r.heater(on=True),
        'decrease': lambda r, mag: r.cooler(on=True),
    }
)
```

## Key Properties

- **Band, not point**: Target is a zone, not a single value. Systems need room to breathe.
- **Asymmetric risks**: Too-low and too-high may have different costs — gain can differ per direction.
- **Hold = success**: Doing nothing when in zone is the correct action. No unnecessary intervention.
- **Drift detection**: Diagnose catches slow systematic drift before it leaves the zone.
- **Oscillation detection**: Catches over-correction (gain too high → system ping-pongs).
- **Composable**: Use with noise-injector (inject noise, regulate operating point) and convergence-detector (detect when regulation has stabilized).

---

**FIN SKILL**
