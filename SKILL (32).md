---
name: noise-injector
description: Inject controlled disorder into any system to escape local optima and enable exploration. Use for "injecte du bruit", "perturbation contrôlée", "escape local minimum", "add randomness", "shake things up", "simulated annealing", "mutation", "data augmentation", or any system stuck in a rut that needs productive disruption. Universal pattern for optimization, creativity, testing, evolution, robustness.
---

# NOISE INJECTOR

Universal controlled perturbation to escape stagnation and enable discovery.

## Core Pattern

```python
class NoiseInjector:
    def __init__(self, noise_type='gaussian', intensity=0.1, 
                 decay='none', bounds=None):
        """
        Args:
            noise_type: gaussian, uniform, structured, scheduled
            intensity: magnitude of perturbation (0-1)
            decay: none, linear, exponential (annealing)
            bounds: optional (min, max) to clamp output
        """
        self.noise_type = noise_type
        self.intensity = intensity
        self.initial_intensity = intensity
        self.decay = decay
        self.bounds = bounds
        self.step = 0
    
    def perturb(self, value):
        """
        Apply noise to value. Works on scalars, vectors, or structures.
        
        Args:
            value: thing to perturb (number, list, dict, string, etc.)
            
        Returns:
            perturbed_value, noise_applied
        """
        self.step += 1
        current_intensity = self._get_intensity()
        
        noise = self._generate_noise(value, current_intensity)
        perturbed = self._apply(value, noise)
        
        if self.bounds:
            perturbed = max(self.bounds[0], min(self.bounds[1], perturbed))
        
        return perturbed, {'intensity': current_intensity, 'noise': noise}
    
    def _get_intensity(self):
        if self.decay == 'none':
            return self.intensity
        elif self.decay == 'linear':
            return max(0, self.initial_intensity * (1 - self.step / 1000))
        elif self.decay == 'exponential':
            return self.initial_intensity * (0.995 ** self.step)
    
    def _generate_noise(self, value, intensity):
        if self.noise_type == 'gaussian':
            return np.random.normal(0, intensity)
        elif self.noise_type == 'uniform':
            return np.random.uniform(-intensity, intensity)
        elif self.noise_type == 'structured':
            # Correlated noise — preserves local structure
            return colored_noise(intensity, correlation=0.8)
        elif self.noise_type == 'scheduled':
            # Burst noise — periodic high-intensity disruption
            if self.step % 100 == 0:
                return np.random.normal(0, intensity * 5)
            return np.random.normal(0, intensity * 0.1)
    
    def _apply(self, value, noise):
        if isinstance(value, (int, float)):
            return value + noise
        elif isinstance(value, list):
            return [v + np.random.normal(0, abs(noise)) for v in value]
        elif isinstance(value, dict):
            return {k: v + np.random.normal(0, abs(noise)) 
                    for k, v in value.items() if isinstance(v, (int, float))}
        return value
```

## Key Insight

Noise is not error. It serves three functions:
1. **Escape** — exit local optima that gradient descent / habit / inertia can't leave
2. **Explore** — discover regions of solution space never visited
3. **Robustify** — train tolerance to imperfection, prevent brittleness

## Example: Simulated Annealing

```python
injector = NoiseInjector(
    noise_type='gaussian',
    intensity=1.0,
    decay='exponential'  # high disruption early, precision late
)

for step in range(1000):
    candidate, _ = injector.perturb(current_solution)
    if score(candidate) > score(current_solution):
        current_solution = candidate
```

## Example: Data Augmentation

```python
injector = NoiseInjector(noise_type='gaussian', intensity=0.05)

augmented_dataset = []
for sample in dataset:
    for _ in range(5):
        noisy, _ = injector.perturb(sample)
        augmented_dataset.append(noisy)
```

## Example: Team Brainstorming

```python
injector = NoiseInjector(noise_type='structured', intensity=0.3)

# Perturb assumptions to generate new angles
for assumption in project_assumptions:
    challenged, _ = injector.perturb(assumption)
    # "What if this assumption was wrong/different?"
```

## Example: Robustness Testing

```python
injector = NoiseInjector(noise_type='uniform', intensity=0.2)

# Test system resilience under noisy conditions
for input_data in test_suite:
    noisy_input, _ = injector.perturb(input_data)
    result = system.process(noisy_input)
    assert result.is_acceptable()  # should degrade gracefully
```

## Noise Type Selection

- **gaussian**: General purpose. Most natural. Symmetric around current state.
- **uniform**: When you want equal probability across perturbation range.
- **structured**: When local coherence matters (text, images, sequences). Correlated noise.
- **scheduled**: When system needs periodic shocks, not constant disruption. Punctuated equilibrium.

## Key Properties

- **Intensity controls risk**: Low = fine-tuning, High = radical exploration
- **Decay enables convergence**: Start noisy, finish precise (annealing)
- **Bounded**: Never perturb outside safe operating range
- **Type-agnostic**: Works on numbers, vectors, structures, even concepts

---

**FIN SKILL**
