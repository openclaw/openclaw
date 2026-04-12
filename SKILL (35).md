---
name: score-profile-classifier
description: Validate if an output is authentic or spurious by scoring across axes then classifying the score profile into diagnostic categories with distinct actions. Use for "valide cette intuition", "c'est création ou hallucination?", "check cohérence", "classify output quality", "triage quality profiles", "diagnostic scoring", or any workflow where raw scores need to be interpreted as a pattern, not just pass/fail. Universal pattern for QA triage, medical screening, investment screening, content moderation, code review classification.
---

# SCORE PROFILE CLASSIFIER

Universal score-profile classifier. Score on axes, then diagnose the *pattern* of scores.

## Core Pattern

```python
class CoherenceValidator:
    def __init__(self, axes, profiles):
        """
        Args:
            axes: List of {name, evaluator} — scoring dimensions
            profiles: List of {name, pattern, action} — diagnostic categories
                pattern: dict of {axis_name: 'high'|'mid'|'low'} 
                action: what to do when this profile matches
        """
        self.axes = axes
        self.profiles = profiles
        self.thresholds = {'low': 0.4, 'mid': 0.6, 'high': 0.75}
    
    def validate(self, candidate):
        """
        Score candidate, then classify score profile.
        
        Returns:
            diagnosis: matched profile name
            action: recommended action
            scores: raw scores per axis
            confidence: how well profile matched
        """
        # Step 1: Score on all axes
        scores = {}
        for axis in self.axes:
            scores[axis['name']] = axis['evaluator'](candidate)
        
        # Step 2: Discretize scores into levels
        levels = {}
        for name, score in scores.items():
            if score >= self.thresholds['high']:
                levels[name] = 'high'
            elif score >= self.thresholds['mid']:
                levels[name] = 'mid'
            else:
                levels[name] = 'low'
        
        # Step 3: Match against known profiles
        best_match = None
        best_confidence = 0
        
        for profile in self.profiles:
            match_count = sum(
                1 for axis, expected in profile['pattern'].items()
                if levels.get(axis) == expected
            )
            confidence = match_count / len(profile['pattern'])
            
            if confidence > best_confidence:
                best_confidence = confidence
                best_match = profile
        
        return {
            'diagnosis': best_match['name'] if best_match else 'unclassified',
            'action': best_match['action'] if best_match else 'review_manually',
            'scores': scores,
            'levels': levels,
            'confidence': best_confidence
        }
```

## Why This Is Different From Multi-Axis-Validator

- **multi-axis-validator**: All axes must pass threshold → binary pass/fail
- **coherence-validator**: Score profile is *classified* into diagnostic categories → each combination means something different, with a different action

One gates. The other diagnoses.

## Example: Creative Output Triage

```python
validator = CoherenceValidator(
    axes=[
        {'name': 'sequential', 'evaluator': fluency_score},
        {'name': 'semantic', 'evaluator': grounding_score},
        {'name': 'multiperspective', 'evaluator': consensus_score},
    ],
    profiles=[
        {
            'name': 'valid_insight',
            'pattern': {'sequential': 'high', 'semantic': 'high', 'multiperspective': 'high'},
            'action': 'surface_immediately'
        },
        {
            'name': 'creative_but_rough',
            'pattern': {'sequential': 'low', 'semantic': 'high', 'multiperspective': 'high'},
            'action': 'surface_with_context'
        },
        {
            'name': 'cliche',
            'pattern': {'sequential': 'high', 'semantic': 'low', 'multiperspective': 'mid'},
            'action': 'reject_silently'
        },
        {
            'name': 'polarizing',
            'pattern': {'sequential': 'mid', 'semantic': 'mid', 'multiperspective': 'low'},
            'action': 'surface_with_caveat'
        },
        {
            'name': 'hallucination',
            'pattern': {'sequential': 'low', 'semantic': 'low', 'multiperspective': 'low'},
            'action': 'reject_permanently'
        },
        {
            'name': 'promising_exploration',
            'pattern': {'sequential': 'low', 'semantic': 'mid', 'multiperspective': 'mid'},
            'action': 'incubate_longer'
        },
    ]
)

result = validator.validate(generated_idea)
# → {'diagnosis': 'creative_but_rough', 'action': 'surface_with_context', ...}
```

## Example: Medical Screening Triage

```python
validator = CoherenceValidator(
    axes=[
        {'name': 'symptom_severity', 'evaluator': symptom_score},
        {'name': 'risk_factors', 'evaluator': risk_profile},
        {'name': 'test_results', 'evaluator': lab_score},
    ],
    profiles=[
        {'name': 'urgent', 'pattern': {'symptom_severity': 'high', 'risk_factors': 'high', 'test_results': 'high'}, 'action': 'immediate_referral'},
        {'name': 'monitor', 'pattern': {'symptom_severity': 'low', 'risk_factors': 'high', 'test_results': 'mid'}, 'action': 'schedule_followup'},
        {'name': 'false_alarm', 'pattern': {'symptom_severity': 'high', 'risk_factors': 'low', 'test_results': 'low'}, 'action': 'reassure_and_retest'},
        {'name': 'healthy', 'pattern': {'symptom_severity': 'low', 'risk_factors': 'low', 'test_results': 'low'}, 'action': 'routine_checkup'},
    ]
)
```

## Example: Code Review Classification

```python
validator = CoherenceValidator(
    axes=[
        {'name': 'correctness', 'evaluator': test_pass_rate},
        {'name': 'readability', 'evaluator': lint_score},
        {'name': 'performance', 'evaluator': benchmark_score},
    ],
    profiles=[
        {'name': 'ship_it', 'pattern': {'correctness': 'high', 'readability': 'high', 'performance': 'high'}, 'action': 'approve'},
        {'name': 'needs_polish', 'pattern': {'correctness': 'high', 'readability': 'low', 'performance': 'high'}, 'action': 'request_cleanup'},
        {'name': 'clever_but_wrong', 'pattern': {'correctness': 'low', 'readability': 'mid', 'performance': 'high'}, 'action': 'reject_with_tests'},
        {'name': 'prototype', 'pattern': {'correctness': 'mid', 'readability': 'low', 'performance': 'low'}, 'action': 'flag_as_draft'},
    ]
)
```

## Key Properties

- **Profile = combination of levels, not individual scores**: High correctness + low readability ≠ low correctness + high readability. The pattern matters.
- **Each diagnosis has a distinct action**: Not just "pass/fail" but "what kind of pass/fail and what to do about it"
- **Extensible**: Add new profiles as you observe new score patterns
- **Composable**: Uses multi-axis-validator for scoring, adds classification layer on top
- **Unclassified fallback**: Unknown profiles → manual review, not silent pass

---

**FIN SKILL**
