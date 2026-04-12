---
name: trajectory-identifier
description: Map a system's multi-metric state into a coordinate space and track its trajectory over time. Identity = path, not point. Use for "identifie trajectoire", "track system state over time", "map metrics to coordinates", "RGB mapping", "state space visualization", "anomaly trajectory", "behavioral fingerprint", or any system where the pattern of change matters more than any single snapshot. Universal pattern for patient monitoring, portfolio tracking, process control, user behavior analysis, system health dashboards, anomaly detection.
---

# TRAJECTORY IDENTIFIER

Universal multi-metric state tracking. Identity is the path, not the point.

## Core Pattern

```python
class TrajectoryIdentifier:
    def __init__(self, axes, normalize=True):
        """
        Args:
            axes: List of {name, measure_fn, range: (min, max)}
                Each axis = one continuous metric
            normalize: If True, map all axes to [0, 1]
        """
        self.axes = axes
        self.normalize = normalize
        self.trajectory = []  # list of timestamped coordinates
    
    def snapshot(self, system, timestamp=None):
        """
        Measure current state, append to trajectory.
        
        Returns:
            coordinates: dict of {axis_name: value}
            color: tuple (for visualization, maps to RGB/HSL/etc)
        """
        import time
        timestamp = timestamp or time.time()
        
        coords = {}
        for axis in self.axes:
            raw = axis['measure_fn'](system)
            if self.normalize:
                lo, hi = axis['range']
                coords[axis['name']] = max(0, min(1, (raw - lo) / (hi - lo)))
            else:
                coords[axis['name']] = raw
        
        point = {'timestamp': timestamp, 'coordinates': coords}
        self.trajectory.append(point)
        
        # Map to color (first 3 axes → RGB)
        values = list(coords.values())
        color = tuple(int(255 * v) for v in values[:3])
        
        return coords, color
    
    def identity(self, window=None):
        """
        Compute trajectory signature over time window.
        Identity = statistical fingerprint of the path.
        
        Returns:
            signature: dict with trajectory properties
        """
        points = self.trajectory[-window:] if window else self.trajectory
        
        if len(points) < 2:
            return {'status': 'insufficient_data'}
        
        all_coords = [p['coordinates'] for p in points]
        
        signature = {}
        for axis in self.axes:
            name = axis['name']
            values = [c[name] for c in all_coords]
            signature[name] = {
                'mean': sum(values) / len(values),
                'variance': _variance(values),
                'trend': values[-1] - values[0],
                'range': max(values) - min(values),
            }
        
        # Cross-axis correlations (do axes move together?)
        if len(self.axes) >= 2:
            signature['correlations'] = _cross_correlations(all_coords, self.axes)
        
        # Trajectory shape metrics
        signature['total_distance'] = _path_length(all_coords, self.axes)
        signature['displacement'] = _displacement(all_coords, self.axes)
        signature['wandering_index'] = (
            signature['total_distance'] / max(signature['displacement'], 0.001)
        )
        # wandering_index: 1 = straight line, high = erratic path
        
        return signature
    
    def detect_anomaly(self, baseline_signature, threshold=2.0):
        """
        Compare current trajectory against baseline.
        
        Returns:
            is_anomaly: bool
            deviation: how far from baseline
            details: per-axis deviation
        """
        current = self.identity(window=20)
        
        if 'status' in current:
            return False, 0, current
        
        deviations = {}
        for axis in self.axes:
            name = axis['name']
            if name in baseline_signature and name in current:
                expected_mean = baseline_signature[name]['mean']
                expected_var = baseline_signature[name]['variance']
                actual_mean = current[name]['mean']
                
                # Z-score style deviation
                std = max(expected_var ** 0.5, 0.001)
                z = abs(actual_mean - expected_mean) / std
                deviations[name] = z
        
        max_deviation = max(deviations.values()) if deviations else 0
        is_anomaly = max_deviation > threshold
        
        return is_anomaly, max_deviation, deviations
    
    def compare(self, other_trajectory):
        """
        Compare two trajectories — are they the same "type" of system?
        
        Returns:
            similarity: 0-1 (1 = identical trajectory shape)
        """
        sig_self = self.identity()
        sig_other = other_trajectory.identity()
        
        similarities = []
        for axis in self.axes:
            name = axis['name']
            if name in sig_self and name in sig_other:
                mean_diff = abs(sig_self[name]['mean'] - sig_other[name]['mean'])
                var_diff = abs(sig_self[name]['variance'] - sig_other[name]['variance'])
                similarities.append(1 - (mean_diff + var_diff) / 2)
        
        return sum(similarities) / max(len(similarities), 1)


def _variance(values):
    mean = sum(values) / len(values)
    return sum((v - mean) ** 2 for v in values) / len(values)

def _path_length(coords_list, axes):
    total = 0
    for i in range(1, len(coords_list)):
        dist = sum(
            (coords_list[i][a['name']] - coords_list[i-1][a['name']]) ** 2
            for a in axes
        ) ** 0.5
        total += dist
    return total

def _displacement(coords_list, axes):
    return sum(
        (coords_list[-1][a['name']] - coords_list[0][a['name']]) ** 2
        for a in axes
    ) ** 0.5

def _cross_correlations(coords_list, axes):
    correlations = {}
    names = [a['name'] for a in axes]
    for i, a in enumerate(names):
        for b in names[i+1:]:
            vals_a = [c[a] for c in coords_list]
            vals_b = [c[b] for c in coords_list]
            mean_a = sum(vals_a) / len(vals_a)
            mean_b = sum(vals_b) / len(vals_b)
            cov = sum((va - mean_a) * (vb - mean_b) for va, vb in zip(vals_a, vals_b))
            std_a = max(_variance(vals_a) ** 0.5, 0.001)
            std_b = max(_variance(vals_b) ** 0.5, 0.001)
            correlations[f'{a}_x_{b}'] = cov / (len(vals_a) * std_a * std_b)
    return correlations
```

## Key Insight

A snapshot tells you *where* a system is. A trajectory tells you *what* it is.

Two systems at the same coordinates right now can have completely different identities — one is stable there, the other is passing through. The path encodes what the point cannot.

## Example: Patient Monitoring

```python
tracker = TrajectoryIdentifier(axes=[
    {'name': 'heart_rate', 'measure_fn': get_hr, 'range': (40, 200)},
    {'name': 'blood_pressure', 'measure_fn': get_bp, 'range': (60, 180)},
    {'name': 'oxygen_sat', 'measure_fn': get_spo2, 'range': (80, 100)},
])

# Take readings every 5 minutes
coords, color = tracker.snapshot(patient)
# color = (R, G, B) visualization of current state

# After enough readings, check identity
sig = tracker.identity(window=12)  # last hour
# sig['wandering_index'] high → patient unstable
# sig['heart_rate']['trend'] > 0 → HR rising

# Compare against healthy baseline
is_anomaly, deviation, details = tracker.detect_anomaly(healthy_baseline)
```

## Example: Portfolio Tracking

```python
tracker = TrajectoryIdentifier(axes=[
    {'name': 'return', 'measure_fn': daily_return, 'range': (-0.1, 0.1)},
    {'name': 'volatility', 'measure_fn': rolling_vol, 'range': (0, 0.5)},
    {'name': 'sharpe', 'measure_fn': rolling_sharpe, 'range': (-2, 4)},
])

# Daily snapshot
coords, color = tracker.snapshot(portfolio)

# Identity over last quarter
sig = tracker.identity(window=60)
# Aggressive portfolio = high return variance, high volatility mean
# Conservative portfolio = low return variance, low volatility mean
# Same current return, different trajectory = different identity
```

## Example: User Behavior Analysis

```python
tracker = TrajectoryIdentifier(axes=[
    {'name': 'session_length', 'measure_fn': avg_session, 'range': (0, 3600)},
    {'name': 'engagement_depth', 'measure_fn': pages_per_session, 'range': (1, 50)},
    {'name': 'return_frequency', 'measure_fn': visits_per_week, 'range': (0, 14)},
])

# Compare two users
similarity = tracker_user_a.compare(tracker_user_b)
# High similarity = same behavior type despite different absolute numbers
```

## Key Properties

- **Normalization**: All axes mapped to [0,1] for comparable coordinate space
- **Color mapping**: First 3 axes → RGB tuple for instant visual identity
- **Wandering index**: path_length / displacement. 1 = straight line, high = erratic
- **Cross-correlations**: Which axes move together? Reveals hidden structure.
- **Anomaly detection**: Z-score deviation from baseline trajectory
- **Trajectory comparison**: Are two systems behaving the same way?
- **Composable**: Feed trajectory data into convergence-detector, operating-point-regulator, pattern-extractor

---

**FIN SKILL**
