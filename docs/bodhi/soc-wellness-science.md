# SOC Wellness Science — Bo's Theoretical Foundation

**Source:** IxH research session — population wellness as coupled critical systems
**Status:** Canonical science reference for bodhi-nudge, Bo's soul, and the criticality engine.

---

## Core Thesis

Population wellness = a stack of interacting self-organized critical systems.
Each has its own sandpile dynamics and power-law events. All are coupled.

The user's body, mind, and social environment are not independent — they are
nested critical systems where small perturbations in one layer cascade into others.

---

## The Five Coupled Critical Systems in Wellness

### 1. Neural / Cognitive Dynamics
- Brain networks operate near a critical regime between order and chaos
- Self-organized tuning via local plasticity rules (Beggs & Plenz 2003; Frontiers 2014)
- Pathological states = maladaptive attractors — rigid patterns the system falls back into
- Insights and learning = neuronal avalanches with power-law size distributions
- **Bo relevance:** Cognitive domain nodes cluster around these attractor states. Patterns at criticality are the highest-value signal.

### 2. Stress and Allostasis (HPA-axis)
- Multilevel interactions connect early stress → endocrine → neurogenesis → vulnerability
- Chronic load pushes system toward critical thresholds where small shocks trigger large breakdowns (burnout, immune crashes)
- **Bo relevance:** Energy level tracking detects proximity to these thresholds. Low energy + stress tags = approaching a critical slope.

### 3. Behavioral Habit Networks
- Health behaviors emerge from interacting beliefs, norms, and expectations — complex networks
- Small, well-timed perturbations (a social cue, a micro-intervention) can flip trajectory
- Classic near-critical behavior: a single grain tips the slope
- **Bo relevance:** The nudge system is a timing optimizer. One question at the right moment > ten questions at the wrong moment.

### 4. Social / Relational Networks
- Support, norms, mood contagion spread on social graphs with cascade dynamics
- Network-level interventions (peer leaders, community rituals) alter connectivity — like changing forest-fire spread
- **Bo relevance:** People nodes and social_context field track these cascades. Cross-domain bridges involving people are often high-criticality signals.

### 5. Health Service and Infrastructure Systems
- Demand/capacity/flow (EDs, clinics) behave like sandpiles: silent accumulation then sudden breakdown
- Anticipate via proximity tracking to critical thresholds
- **Bo relevance:** Not directly modeled in bodhi1, but relevant for Qenjin Console (Ketamine Clinics use case).

---

## Just-in-Time Adaptive Intervention (JITAI) Model

The scientific literature (PMC 2017, PMC 2025) defines the optimal nudge architecture:

1. **State sensing:** ingest light signals — engagement data, self-report check-ins, calendar patterns, wearable summaries
2. **Decision rules:** if hydration <40% two days + sleep <6h → downgrade cardio from "must" to "walk 10 min"
3. **Trigger engine:** intervene at "state of opportunity" (after sedentary streaks, before known stress windows, after missed check-ins)

**Bo's nudge system already implements this.** The SOC-based revisit tracker (expanding intervals: 3→7→14→30 days) IS the adaptive timing layer.

---

## Sandpile Rules for Bo's Nudge System

Applied from the literature to the vault:

| System Load Indicator | Bo's Action |
|----------------------|-------------|
| Domain cluster ripe (14+ days active) | Surface ONE pattern question |
| Energy level consistently 1-2 | Do not add challenge. Recovery message only. |
| Cross-domain bridge detected | Surface immediately — highest value |
| 3+ missed practices in a row | Downgrade difficulty. Shorter ask. |
| Energy 4-5, cluster ripe | Maximum depth question — system near peak receptivity |

**The grain as full state-space:** each vault node is not a scalar but a vector across:
bio → neural → psychological → social → environmental

---

## Attractor / Threshold Metrics (Advanced — Phase F+)

For a future "criticality engine" layer:

- **Resilience:** speed of recovery after perturbation (energy level return time after dip)
- **Early warning indicators:** critical slowing, rising variance, increasing cross-domain correlation before regime shift
- **Trajectory curves:** green (stable), amber (near edge), red (frequent avalanches)

This is the foundation for Qenjin Console's "trajectory view" in the Clinic Patient Success use case.

---

## Key Papers
- Beggs & Plenz (2003): neuronal avalanches, power-law distributions in cortical networks
- Frontiers in Systems Neuroscience (2014): SOC as fundamental property of neural systems
- PMC 5364076 (2017): JITAI in mobile health — decision rules, trigger timing
- PMC 11862764 (2025): JITAI for behavioral health — evidence base
- PMC 3937932: Network theory of health systems and well-being cycles
- Complex Systems and Health Behavior Change (Orr & Plaut, 2014): habit network dynamics

---

## Practical Encoding Axes (for Criticality Engine v1)

1. **Time-series layers:** physiology (sleep, HRV), mood/cognition, behavior logs, service usage, social signals, life events
2. **Network layers:** interpersonal graphs, provider networks, community structures
3. **Attractor metrics:** resilience, early-warning indicators (critical slowing, rising variance)

Stack order:
1. Critical routines engine (what bodhi1 owns now via Bo)
2. Adaptive timing / JITAI (bodhi-nudge expanding intervals)
3. Population-level modeling (Qenjin Console future — clinic trajectory curves)
