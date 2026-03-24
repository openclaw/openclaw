---
name: metric-calculator
description: Universal evaluation and scoring. Use for "calcule métrique", "evaluate performance", "score results", "measure quality", or any evaluation workflow. Applies to any domain - ML accuracy, business KPIs, prediction quality, system health.
---

# METRIC CALCULATOR

Universal evaluation and scoring system.

## Core Pattern

```python
def calculate_metric(
    predictions,
    ground_truth,
    metric_type='accuracy'  # accuracy, precision, recall, mse, mae, custom
):
    """
    Calculate performance metric
    
    Args:
        predictions: Model/system outputs
        ground_truth: True values
        metric_type: Which metric to compute
        
    Returns:
        score, details
    """
    
    if metric_type == 'accuracy':
        return accuracy(predictions, ground_truth)
    
    elif metric_type == 'precision':
        return precision(predictions, ground_truth)
    
    elif metric_type == 'recall':
        return recall(predictions, ground_truth)
    
    elif metric_type == 'f1':
        return f1_score(predictions, ground_truth)
    
    elif metric_type == 'mse':
        return mean_squared_error(predictions, ground_truth)
    
    elif metric_type == 'mae':
        return mean_absolute_error(predictions, ground_truth)
    
    elif metric_type == 'rmse':
        return root_mean_squared_error(predictions, ground_truth)
    
    elif metric_type == 'r2':
        return r_squared(predictions, ground_truth)

# Classification metrics

def accuracy(predictions, ground_truth):
    """Proportion correct"""
    correct = sum(p == g for p, g in zip(predictions, ground_truth))
    total = len(predictions)
    return correct / total

def precision(predictions, ground_truth, positive_class=1):
    """Of predicted positives, how many correct?"""
    true_positives = sum((p == positive_class and g == positive_class) 
                        for p, g in zip(predictions, ground_truth))
    predicted_positives = sum(p == positive_class for p in predictions)
    
    return true_positives / predicted_positives if predicted_positives > 0 else 0

def recall(predictions, ground_truth, positive_class=1):
    """Of actual positives, how many found?"""
    true_positives = sum((p == positive_class and g == positive_class) 
                        for p, g in zip(predictions, ground_truth))
    actual_positives = sum(g == positive_class for g in ground_truth)
    
    return true_positives / actual_positives if actual_positives > 0 else 0

def f1_score(predictions, ground_truth):
    """Harmonic mean of precision and recall"""
    prec = precision(predictions, ground_truth)
    rec = recall(predictions, ground_truth)
    
    if prec + rec == 0:
        return 0
    
    return 2 * (prec * rec) / (prec + rec)

# Regression metrics

def mean_squared_error(predictions, ground_truth):
    """Average squared difference"""
    squared_errors = [(p - g)**2 for p, g in zip(predictions, ground_truth)]
    return sum(squared_errors) / len(squared_errors)

def mean_absolute_error(predictions, ground_truth):
    """Average absolute difference"""
    abs_errors = [abs(p - g) for p, g in zip(predictions, ground_truth)]
    return sum(abs_errors) / len(abs_errors)

def root_mean_squared_error(predictions, ground_truth):
    """RMSE - more sensitive to large errors"""
    mse = mean_squared_error(predictions, ground_truth)
    return np.sqrt(mse)

def r_squared(predictions, ground_truth):
    """Proportion of variance explained"""
    mean_gt = np.mean(ground_truth)
    ss_total = sum((g - mean_gt)**2 for g in ground_truth)
    ss_residual = sum((g - p)**2 for g, p in zip(ground_truth, predictions))
    
    return 1 - (ss_residual / ss_total)

# Custom composite metrics

def calculate_composite_metric(predictions, ground_truth, weights):
    """
    Combine multiple metrics
    
    Args:
        weights: {'accuracy': 0.5, 'f1': 0.3, 'precision': 0.2}
    """
    
    scores = {}
    for metric_name, weight in weights.items():
        score = calculate_metric(predictions, ground_truth, metric_name)
        scores[metric_name] = score
    
    # Weighted average
    composite = sum(scores[m] * weights[m] for m in weights)
    
    return {
        'composite': composite,
        'components': scores
    }

# Domain-specific metrics

def hockey_prediction_score(predictions, ground_truth):
    """OMNI-style scoring"""
    scores = []
    
    for pred, actual in zip(predictions, ground_truth):
        if pred['winner'] == actual['winner'] and pred['score'] == actual['score']:
            scores.append(1.0)  # Perfect
        elif pred['winner'] == actual['winner']:
            scores.append(0.5)  # Right winner
        else:
            scores.append(0.0)  # Wrong
    
    return np.mean(scores)

def business_kpi_score(metrics, targets):
    """Business metrics vs targets"""
    scores = {}
    
    for kpi, value in metrics.items():
        target = targets.get(kpi, 0)
        
        if target == 0:
            scores[kpi] = 0
        else:
            # Percentage of target achieved
            scores[kpi] = min(value / target, 1.0)
    
    return {
        'overall': np.mean(list(scores.values())),
        'kpis': scores
    }
```

## Example: Evaluate Model

```python
# Get predictions
predictions = model.predict(test_data)
ground_truth = test_data.labels

# Calculate multiple metrics
metrics = {
    'accuracy': calculate_metric(predictions, ground_truth, 'accuracy'),
    'precision': calculate_metric(predictions, ground_truth, 'precision'),
    'recall': calculate_metric(predictions, ground_truth, 'recall'),
    'f1': calculate_metric(predictions, ground_truth, 'f1')
}

print(f"Model performance: {metrics}")
```

---

**FIN SKILL**
