---
name: king_skill_scipy_sim
description: Scientific simulation using scipy, numpy, and open-source simulators. Covers ODEs, PDEs, thermodynamics, signal processing.
metadata:
  openclaw:
    emoji: 🌊
    requires:
      bins: ["python3", "pip"]
    install:
      - type: pip
        packages: ["scipy", "numpy", "matplotlib", "qutip"]
    os: ["darwin", "linux", "win32"]
---

# SciPy Simulation

Scientific simulation using scipy, numpy, and open-source simulators.

## When to Use

**USE this skill when:**
- Simulating ODEs/PDEs
- Thermodynamic modeling
- Signal processing
- Fluid dynamics (basic)
- Quantum mechanics simulations
- Circuit simulation
- Reservoir computing

**DON'T use when:**
- Analytical solution exists (use `king_skill_sympy`)
- Simple numerical computation suffices (use `king_skill_python_executor`)

## Commands

### ODE / Dynamical Systems

```python
from scipy.integrate import solve_ivp
import numpy as np

# Lorenz attractor (chaotic system)
def lorenz(t, state, sigma=10, rho=28, beta=8/3):
    x, y, z = state
    return [sigma*(y-x), x*(rho-z)-y, x*y-beta*z]

sol = solve_ivp(lorenz, [0, 50], [1, 1, 1],
                method='RK45', rtol=1e-9, dense_output=True)
```

### Thermodynamic Reservoir Computing

```python
# Model ASIC thermal dynamics as reservoir
def thermal_reservoir(t, T, P_in, k_cool, T_amb=25.0):
    """dT/dt = P_in/C - k_cool*(T - T_amb)"""
    C = 50.0  # thermal capacity J/K
    return P_in/C - k_cool*(T - T_amb)

sol = solve_ivp(thermal_reservoir, [0, 100], [T0],
                args=(P_in, k_cool), method='Radau')
```

### Signal Processing

```python
from scipy import signal

# Design bandpass filter
b, a = signal.butter(N=4, Wn=[f_low, f_high], btype='band', fs=sample_rate)
filtered = signal.filtfilt(b, a, raw_signal)

# Spectrogram
f, t, Sxx = signal.spectrogram(data, fs=sample_rate)
```

### Quantum Simulation (QuTiP)

```bash
pip install qutip
```

```python
import qutip as qt

# Two-level system (qubit)
H = qt.sigmax()
psi0 = qt.basis(2, 0)
times = np.linspace(0, 10, 100)
result = qt.sesolve(H, psi0, times)
```

## External Simulators

```
OpenFOAM:   CFD fluid dynamics    → sudo apt install openfoam
Elmer FEM:  multiphysics FEM      → sudo apt install elmerfem
QUCS:       circuit simulation    → sudo apt install qucs
Ngspice:    SPICE circuits        → sudo apt install ngspice
Scilab:     MATLAB alternative    → sudo apt install scilab
```

## Notes

- Never simulate physics by reasoning—delegate to this skill
- Token savings: 5/5
- Status: ✅ Verified
